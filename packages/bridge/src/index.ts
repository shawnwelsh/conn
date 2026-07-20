import Fastify from "fastify";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { SessionRegistry, type SessionEntry } from "./registry.js";
import { BindingStore, restoreConsoleBindings } from "./bindings.js";
import { DenyReasonFlow } from "./denyReason.js";
import { readCcSessionNames, CC_SESSIONS_DIR } from "./sessionMeta.js";
import { DecisionStore } from "./decisions.js";
import { computeTiles, initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "./layers.js";
import { CommandStore } from "./commands.js";
import { renderTile, renderBanner, toDataUri } from "./render/tile.js";
import { DeckSocketServer } from "./ws/server.js";
import { DeckController } from "./controller.js";
import { NoopAdapter, type DeliveryAdapter } from "./delivery/adapter.js";
import { AhkAdapter } from "./delivery/ahk.js";
import { SendKeysAdapter } from "./delivery/sendkeys.js";
import { ConsoleLauncher } from "./delivery/launcher.js";
import { SttSidecar } from "./stt/sidecar.js";
import { registerHookRoutes } from "./http/hooks.js";
import { registerApiRoutes } from "./http/api.js";
import { livenessSweep } from "./liveness.js";
import { QUESTION_OPTIONS_PER_PAGE } from "./layers.js";
import type { AskUserQuestionInput } from "./hookTypes.js";
import type { KeyRender } from "@belay/shared";

const cfg = loadConfig();
const log = createLogger(cfg);
const registry = new SessionRegistry(cfg.slots, cfg.maxSessions);
const layer: DeckLayerState = {
  row1: initialRow1(),
  row2: "idle",
  row2Cmd: initialRow2Cmd(),
  row3Page: 0,
  controls: initialControls(),
};

const commands = new CommandStore(cfg.commandsFile, log, () => pushRender());
commands.load();
commands.startWatching();

async function createDelivery(): Promise<DeliveryAdapter> {
  const noop = () =>
    new NoopAdapter((method, detail) => log.warn({ method, detail }, "delivery unavailable (noop adapter)"));
  if (cfg.delivery.adapter === "sendkeys") return new SendKeysAdapter(log, cfg.delivery.windowMode);
  if (cfg.delivery.adapter === "ahk") {
    const ahk = new AhkAdapter(cfg.delivery.ahkPath, log, cfg.delivery.windowMode);
    try {
      await ahk.start();
      return ahk;
    } catch (err) {
      log.warn({ err: String(err) }, "AHK adapter unavailable — falling back to noop");
      return noop();
    }
  }
  return noop();
}
const delivery = await createDelivery();

// Console bindings survive restarts: restore live ones BEFORE hooks can
// arrive, so a returning session adopts its console key (kind + HWND)
// instead of re-registering as a desktop session. Skip when delivery can't
// resolve windows (noop) — pruning would wrongly erase every binding.
const bindings = new BindingStore(join(cfg.log.dir, "console-bindings.json"), log);
if (delivery instanceof AhkAdapter) {
  await restoreConsoleBindings(bindings, registry, delivery, log);
}
registry.on("windowDead", (entry: SessionEntry) => bindings.removeByCwd(entry.cwd));

const app = Fastify({ logger: false });

let sockets: DeckSocketServer;
let lastImages: string[] = [];
let flashPhase = false;
let flashTimer: ReturnType<typeof setInterval> | null = null;

/** Render loop: recompute all 15 tiles, broadcast only the ones that changed.
 * The tile cache makes unchanged tiles nearly free to recompute. */
function pushRender(): void {
  // Boot: events can fire (e.g. STT status) before the WS server exists;
  // the explicit pushRender() after listen paints whatever state accrued.
  if (!sockets) return;
  const tiles = computeTiles(registry, layer, cfg, commands.all(), flashPhase);
  const images = tiles.map((t) => {
    // Banner tiles are slices of one wide image; renderBanner caches slices.
    if (t.bannerSpan && t.bannerIndex !== undefined) {
      return toDataUri(renderBanner(t.text, t.bannerSpan, t.state)[t.bannerIndex]!);
    }
    return toDataUri(renderTile(t));
  });
  const changed: KeyRender[] = [];
  images.forEach((image, slot) => {
    if (image !== lastImages[slot]) changed.push({ slot, image });
  });
  lastImages = images;
  const full = images.map((image, slot) => ({ slot, image }));
  sockets.broadcast(changed, full);
}

const decisions = new DecisionStore(
  cfg.decisionTimeoutSeconds * 1000,
  log,
  () => sockets?.clientCount > 0,
  () => syncPermissionLayer(),
  cfg.alwaysAllowDestination,
);

/** Anything that needs the 2Hz flash: a held permission, a question morph, or
 * the pager signalling multiple sessions need attention. */
function flashNeeded(): boolean {
  return (
    decisions.current !== undefined ||
    layer.row2 === "question" ||
    registry.pagerFlashing() ||
    layer.launching === true ||
    layer.ptt === "recording" ||
    layer.ptt === "transcribing"
  );
}

/** Run the flash animation only while something needs it. */
function syncFlash(active: boolean): void {
  if (active && !flashTimer) {
    flashTimer = setInterval(() => {
      flashPhase = !flashPhase;
      pushRender();
    }, 500);
  } else if (!active && flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
    flashPhase = false;
  }
}

let denyReason: DenyReasonFlow | null = null;

/** Keep the row-2 layer in lockstep with the decision queue. A pending
 * permission outranks a question layer. */
function syncPermissionLayer(): void {
  // A queue change means any in-flight deny-reason dictation may be moot.
  denyReason?.sync();
  const current = decisions.current;
  if (current) {
    layer.row2 = "permission";
    layer.permission = {
      sessionId: current.sessionId,
      toolName: current.toolName,
      summary: current.summary,
    };
    registry.target(current.sessionId); // auto-target the requester
  } else if (layer.row2 === "permission") {
    layer.row2 = "idle";
    layer.permission = undefined;
  }
  syncFlash(flashNeeded());
  pushRender();
}

/** Question morph layer — never blocks the hook; the deck is an alternate
 * answering surface and reverts as soon as the session moves on. */
function showQuestion(event: Parameters<typeof decisions.hold>[0]): void {
  const input = event.tool_input as AskUserQuestionInput | undefined;
  const q = input?.questions?.[0];
  if (!q?.options?.length) return;
  layer.row2 = "question";
  layer.question = {
    sessionId: event.session_id,
    question: q.question,
    options: q.options.map((o) => o.label),
    page: 0,
  };
  registry.target(event.session_id);
  syncFlash(flashNeeded());
  pushRender();
}

function revertQuestion(): void {
  if (layer.row2 !== "question") return;
  layer.row2 = "idle";
  layer.question = undefined;
  syncFlash(flashNeeded());
  pushRender();
}

const controller = new DeckController(registry, layer, delivery, cfg, log, () => {
  syncFlash(flashNeeded());
  pushRender();
});
controller.setLauncher(
  new ConsoleLauncher(
    registry,
    delivery,
    cfg.newSessionCommand,
    log,
    cfg.newSessionWorktrees,
    cfg.worktreeTimeoutSeconds * 1000,
    undefined,
    bindings,
    cfg.consoleHost,
  ),
);
controller.setCommands(commands);
// A hand-given name has no branch to live in — persist it with the console
// binding so it survives restarts.
controller.setOnSessionRenamed((session) => bindings.setLabel(session.cwd, session.label));

// Push-to-talk sidecar: model load (and first-run download) happens in the
// background; the mic key tracks its status and stays "offline" gracefully
// when deps are missing.
let stt: SttSidecar | null = null;
if (cfg.ptt.enabled) {
  stt = new SttSidecar(
    { python: cfg.ptt.python, model: cfg.ptt.model, language: cfg.ptt.language, device: cfg.ptt.device },
    log,
    (status) => {
      layer.ptt = status;
      syncFlash(flashNeeded());
      pushRender();
    },
  );
  controller.setStt(stt);
  void stt.ensureStarted();
}

denyReason = new DenyReasonFlow(decisions, stt ?? undefined, layer, cfg.ptt.reasonMaxSeconds, log, () => {
  syncFlash(flashNeeded());
  pushRender();
});

controller.setHooks({
  onPermissionKey: (index) => {
    const action = (["allow", "always-allow", "deny", "deny-reason", "show-on-screen"] as const)[index];
    if (!action) return;
    if (action === "deny-reason") {
      // Dictation flow: records against the held decision, resolves it with
      // the transcribed reason (canned deny when the sidecar can't).
      denyReason?.press();
      return;
    }
    const settled = decisions.decide(action);
    if (settled && action === "show-on-screen") {
      const session = registry.get(settled.sessionId);
      if (session) void delivery.focus(session);
    }
  },
  onQuestionKey: (optionIndex) => {
    const q = layer.question;
    if (!q) return;
    const absolute = q.page * QUESTION_OPTIONS_PER_PAGE + optionIndex;
    if (absolute >= q.options.length) return;
    const session = registry.get(q.sessionId);
    if (!session) return revertQuestion();
    void (async () => {
      // v1 keystroke model (verify live in Phase 3 exit test): focus the
      // session, type the option number, confirm with Enter.
      const ok =
        (await delivery.focus(session)) &&
        (await delivery.sendKey(session, String(absolute + 1))) &&
        (await delivery.sendKey(session, "enter"));
      log.info({ session: q.sessionId, option: q.options[absolute], ok }, "question answered from deck");
      revertQuestion();
    })();
  },
  onQuestionPager: () => {
    const q = layer.question;
    if (!q) return;
    const pages = Math.ceil(q.options.length / QUESTION_OPTIONS_PER_PAGE);
    if (pages > 1) {
      q.page = (q.page + 1) % pages;
      pushRender();
    } else {
      // Single page → the key is "Cancel": hand back to the screen.
      revertQuestion();
    }
  },
});

registry.on("changed", () => {
  syncFlash(flashNeeded());
  pushRender();
});

registerHookRoutes(app, registry, log, {
  onPermissionRequest: (event) => decisions.hold(event),
  onSessionEnd: (sessionId) => decisions.releaseSession(sessionId),
  onQuestion: (event) => showQuestion(event),
  onAnyEvent: (sessionId) => {
    // Any further activity from the asking session means the question was
    // answered (on screen or via the deck) or abandoned.
    if (layer.row2 === "question" && layer.question?.sessionId === sessionId) revertQuestion();
  },
});
await registerApiRoutes(app, registry, layer);

await app.listen({ port: cfg.port, host: "127.0.0.1" });

sockets = new DeckSocketServer(
  app.server,
  log,
  (slot, edge) => (edge === "down" ? controller.down(slot) : controller.up(slot)),
  (count) => log.info({ count }, "deck clients"),
);
pushRender();

log.info({ port: cfg.port }, `belay bridge up — web deck at http://127.0.0.1:${cfg.port}/`);

// Periodic sweep: re-derive labels (branch renames reach the buttons), skull
// and demote dead-window sessions (3h TTL sweep), refresh stale dimming.
setInterval(() => {
  // Claude Code's own `/rename` reaches the button here (its session
  // metadata is the only place that name is published).
  registry.refreshLabels(readCcSessionNames(CC_SESSIONS_DIR, log));
  void livenessSweep(registry, delivery, cfg.deadSessionSweepHours * 3_600_000, log).finally(() =>
    pushRender(),
  );
}, 30_000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    commands.dispose();
    stt?.dispose();
    void delivery.dispose().finally(() => process.exit(0));
  });
}
