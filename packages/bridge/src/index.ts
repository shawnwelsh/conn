import Fastify from "fastify";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { SessionRegistry, pathWithin, type SessionEntry } from "./registry.js";
import type { SessionStatus } from "@conn/shared";
import { BindingStore, restoreConsoleBindings } from "./bindings.js";
import { DenyReasonFlow } from "./denyReason.js";
import { readCcSessionNames, readCliSessions, readWaitingSessionIds, CC_SESSIONS_DIR } from "./sessionMeta.js";
import { DecisionStore } from "./decisions.js";
import {
  advanceQuestion,
  computeTiles,
  currentQuestion,
  initialControls,
  initialRow1,
  initialRow2Cmd,
  targetAfterInterrupt,
  type DeckLayerState,
} from "./layers.js";
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
import { endsPendingQuestion } from "./status.js";
import { ensureSidecarDir, looksEnumerated, readOptions } from "./optionReader.js";
import { deliverQuestionAnswer, deliverMultiSelectAnswer } from "./questionKeys.js";
import { QUESTION_OPTIONS_PER_PAGE } from "./layers.js";
import { awaitingSpokenAnswer } from "./suggestions.js";
import type { AskUserQuestionInput } from "./hookTypes.js";
import type { KeyRender } from "@conn/shared";

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
// Restore the saved row-1 order (by cwd) BEFORE any session is adopted, so
// each rediscovered session slots back to where you last dragged it.
const orderFile = join(cfg.log.dir, "row1-order.json");
try {
  if (existsSync(orderFile)) {
    const saved = JSON.parse(readFileSync(orderFile, "utf8"));
    if (Array.isArray(saved)) registry.loadOrder(saved.filter((c): c is string => typeof c === "string"));
  }
} catch (err) {
  log.warn({ err: String(err) }, "row1-order: could not read saved order");
}
registry.on("reordered", () => {
  try {
    writeFileSync(orderFile, JSON.stringify(registry.orderedCwds(), null, 2) + "\n");
  } catch (err) {
    log.warn({ err: String(err) }, "row1-order: could not persist order");
  }
});

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
let slowPhase = false;
let slowTimer: ReturnType<typeof setInterval> | null = null;

/** Render loop: recompute all 15 tiles, broadcast only the ones that changed.
 * The tile cache makes unchanged tiles nearly free to recompute. */
function pushRender(): void {
  // Boot: events can fire (e.g. STT status) before the WS server exists;
  // the explicit pushRender() after listen paints whatever state accrued.
  if (!sockets) return;
  const tiles = computeTiles(registry, layer, cfg, commands.all(), flashPhase, slowPhase);
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

/** Anything that needs the 2Hz flash: a held permission, a question morph, a
 * launch in flight, or a live dictation. Off-page attention is deliberately
 * NOT here — it colours the Page key instead of strobing it forever. */
function flashNeeded(): boolean {
  return (
    decisions.current !== undefined ||
    layer.row2 === "question" ||
    layer.launching === true ||
    layer.ptt === "recording" ||
    layer.ptt === "transcribing" ||
    // A spoken-answer question is up and the mic is ready — pulse "Answer".
    (layer.ptt === "ready" && awaitingSpokenAnswer(registry, layer))
  );
}

/**
 * The slow breath, for sessions blocked on a prompt the deck can't answer.
 * ~1s per half-cycle against the flash's 500ms, so the two rhythms read as
 * different things rather than "one key is a bit out of step". Runs only while
 * a session is actually waiting, so an idle deck does no work.
 */
function syncSlowPulse(): void {
  const active = registry.all().some((s) => s.status === "waiting");
  if (active && !slowTimer) {
    slowTimer = setInterval(() => {
      slowPhase = !slowPhase;
      pushRender();
    }, 1000);
  } else if (!active && slowTimer) {
    clearInterval(slowTimer);
    slowTimer = null;
    slowPhase = false;
  }
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

/**
 * The session you were working in before an interrupt grabbed the deck. Both
 * interrupt surfaces — a held permission and a question morph — auto-target
 * whoever needs you, which is right for answering but strands you there once
 * you're done. We remember the origin at the OUTERMOST interrupt and hand the
 * target back when the deck returns to idle, so being interrupted costs an
 * answer, not an answer plus a re-select. A stack (permission over question,
 * or a queue of permissions) keeps the first origin and unwinds to it.
 */
let focusReturn: string | undefined;

/** True while the deck is showing an interrupt morph rather than the idle
 * command surface — i.e. a permission or a question owns row 2. */
function inMorph(): boolean {
  return layer.row2 === "permission" || layer.row2 === "question";
}

/** Record who we were working in, but only for the outermost interrupt: if a
 * morph is already up (`wasMorph`) the current target is the previous
 * interrupter, not the origin, so leave the earlier note intact. Call BEFORE
 * the interrupt retargets the deck. */
function noteFocusOrigin(wasMorph: boolean): void {
  if (!wasMorph && focusReturn === undefined) {
    focusReturn = registry.targetedSession?.sessionId;
  }
}

/** Hand the target back to the pre-interrupt session once the deck is fully
 * idle again. Self-guards: does nothing while any morph is still up, so it's
 * safe to call from every revert path. */
function restoreFocusAfterMorph(): void {
  if (inMorph()) return; // still handling something — hold the note
  const back = targetAfterInterrupt(
    focusReturn,
    registry.targetedSession?.sessionId ?? null,
    (id) => registry.get(id) !== undefined,
  );
  focusReturn = undefined;
  if (back) registry.target(back);
}

/** Keep the row-2 layer in lockstep with the decision queue. A pending
 * permission outranks a question layer. */
function syncPermissionLayer(): void {
  // A queue change means any in-flight deny-reason dictation may be moot.
  denyReason?.sync();
  const current = decisions.current;
  const wasMorph = inMorph();
  if (current) {
    noteFocusOrigin(wasMorph); // remember the origin before we retarget
    layer.row2 = "permission";
    layer.permission = {
      sessionId: current.sessionId,
      toolName: current.toolName,
      summary: current.summary,
      depth: decisions.depth,
      expiresAt: current.expiresAt,
    };
    registry.target(current.sessionId); // auto-target the requester
  } else if (layer.row2 === "permission") {
    layer.row2 = "idle";
    layer.permission = undefined;
  }
  restoreFocusAfterMorph(); // no-op until every morph has cleared
  syncFlash(flashNeeded());
  pushRender();
}

/** Question morph layer — never blocks the hook; the deck is an alternate
 * answering surface and reverts as soon as the session moves on. */
function showQuestion(event: Parameters<typeof decisions.hold>[0]): void {
  const input = event.tool_input as AskUserQuestionInput | undefined;
  // Take EVERY question in the call. Claude commonly asks several at once,
  // and only ever showing questions[0] meant the deck answered one and
  // abandoned the rest, leaving the console on question 2 with no panel.
  const questions = (input?.questions ?? [])
    .filter((q) => q?.options?.length)
    .map((q) => ({ question: q.question, options: (q.options ?? []).map((o) => o.label), multiSelect: q.multiSelect }));
  if (!questions.length) return;
  noteFocusOrigin(inMorph()); // remember the origin before we retarget
  layer.row2 = "question";
  layer.question = {
    sessionId: event.session_id,
    questions,
    index: 0,
    page: 0,
    checked: [],
  };
  registry.target(event.session_id);
  syncFlash(flashNeeded());
  pushRender();
}

/**
 * A turn ended on prose that may put choices to you. Read it with the cheap
 * model so those choices become keys.
 *
 * Fire-and-forget and heavily gated: off unless configured, console sessions
 * only (accept types into a specific window), and only when the text looks
 * like it enumerates alternatives — the free heuristics already handle yes/no
 * offers and open questions, and on a subscription every call spends the
 * owner's usage. Any failure leaves the plain reading surface, which is always
 * a correct answer.
 */
async function readTurnOptions(sessionId: string, lastMessage: string): Promise<void> {
  if (!cfg.optionReader.enabled) return;
  const session = registry.get(sessionId);
  if (!session || session.windowKind !== "console") return;
  // Capture the specific offer we're reading, by VALUE. The read takes ~15-25s,
  // and the earlier guard compared the live entry's suggestion to ITSELF (same
  // object) — always true — so options attached even after you answered on
  // screen and moved on, dropping a stale list under a live session.
  const forSuggestion = session.suggestion;
  if (!forSuggestion) return; // nothing was offered
  if (!looksEnumerated(lastMessage)) return;
  session.optionsPending = true;
  pushRender();
  const stillThisTurn = () => registry.get(sessionId)?.suggestion === forSuggestion;
  try {
    const found = await readOptions(lastMessage, {
      cwd: ensureSidecarDir(),
      model: cfg.optionReader.model,
      timeoutMs: cfg.optionReader.timeoutSeconds * 1000,
      log,
    });
    if (!found) return;
    if (stillThisTurn()) {
      registry.get(sessionId)!.suggestionOptions = found;
      log.info({ session: sessionId, options: found.options, viewInWindow: found.viewInWindow }, "option reader");
    } else {
      log.info({ session: sessionId }, "option reader: turn moved on during the read — options discarded");
    }
  } finally {
    // Only clear OUR pending flag; a newer turn (answered on screen, or a fresh
    // Stop) already cleared it and may have started its own read.
    if (stillThisTurn()) registry.get(sessionId)!.optionsPending = false;
    pushRender();
  }
}

function revertQuestion(): void {
  if (layer.row2 !== "question") return;
  layer.row2 = "idle";
  layer.question = undefined;
  restoreFocusAfterMorph(); // hand the target back to your pre-question session
  syncFlash(flashNeeded());
  pushRender();
}

const controller = new DeckController(registry, layer, delivery, cfg, log, () => {
  syncFlash(flashNeeded());
  pushRender();
});
const launcher = new ConsoleLauncher(
  registry,
  delivery,
  cfg.newSessionCommand,
  log,
  cfg.newSessionWorktrees,
  cfg.worktreeTimeoutSeconds * 1000,
  undefined,
  bindings,
  cfg.consoleHost,
);
controller.setLauncher(launcher);
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

denyReason = new DenyReasonFlow(
  decisions,
  stt ?? undefined,
  layer,
  cfg.ptt.reasonMaxSeconds,
  log,
  () => {
    syncFlash(flashNeeded());
    pushRender();
  },
  // How the dictated reason is resolved. A normal permission denies through
  // the still-held hook; a console PLAN can't (its hook is ignored once the
  // menu shows), so it rejects the menu with Esc and types the reason instead
  // — same recording UI, different last step.
  (text) => {
    const pending = decisions.current;
    if (!pending) return;
    const session = registry.get(pending.sessionId);
    if (pending.toolName === "ExitPlanMode" && session?.windowKind === "console") {
      void (async () => {
        await delivery.focus(session);
        await delivery.sendKey(session, "escape"); // reject → back to plan mode
        let typed = false;
        if (text) {
          // Let the console leave the plan menu and re-render its prompt before
          // typing — an immediate sendText lands in the transient rejection
          // state and is dropped (the reason never reaches Claude).
          await new Promise((r) => setTimeout(r, 350));
          typed =
            (await delivery.sendText(session, text)) &&
            (await new Promise<boolean>((r) => setTimeout(() => r(true), 150))) &&
            (await delivery.sendKey(session, "enter")); // send the refinement
        }
        decisions.decide("show-on-screen"); // release the moot hook, dismiss the panel
        log.info(
          { session: session.sessionId, chars: text?.length ?? 0, typed },
          text ? "plan kept with dictated reason" : "plan kept — empty transcription, no reason typed",
        );
      })();
      return;
    }
    decisions.decide("deny-reason", text ? { message: text } : undefined);
  },
);

/**
 * Restart the bridge from the deck's Reboot key. The bridge can't restart in
 * place — it holds the port and serves the deck — so it hands off: spawn a
 * DETACHED restarter that waits for THIS process to exit (which frees the
 * port), then runs cfg.restartCommand to relaunch, and only then does the
 * bridge exit. Inline `powershell -Command` isn't gated by the script-execution
 * policy. The deck blanks for a couple of seconds and its clients reconnect on
 * their own.
 */
function rebootBridge(): void {
  // Supervised: just die. scripts/run-bridge-hidden.vbs is sitting in a wait on
  // this process and relaunches the moment it returns, so there is nothing to
  // spawn and nothing that has to outlive us. That last part is the whole
  // point — every previous attempt failed because the restarter had to survive
  // its dying parent (a detached spawn, then WMI, both silently didn't).
  if (cfg.supervised) {
    log.warn("reboot: exiting for the supervisor to relaunch us");
    process.exit(0);
  }
  if (!cfg.restartCommand) {
    log.warn("reboot ignored: not supervised and no restartCommand configured");
    return;
  }
  log.warn("reboot: NOT supervised — attempting the legacy self-restart, which is unreliable");
  log.warn({ restartCommand: cfg.restartCommand }, "reboot: restarting the bridge from the deck");
  const port = cfg.port;
  const logFile = resolve(cfg.log.dir, "reboot.log").replace(/'/g, "''"); // absolute + single-quote-safe for PS
  // The restarter: wait for THIS bridge to free the port, then relaunch the
  // successor and RETRY until it actually binds, stopping the instant the port
  // comes up (so it can never stack duplicate bridges) and appending each step
  // to reboot.log.
  const restarter =
    `$ErrorActionPreference='SilentlyContinue';` +
    `function L($m){ ([string](Get-Date)+' '+$m) | Out-File -Append -Encoding utf8 '${logFile}' };` +
    `L 'restarter up';` +
    `L 'waiting for port ${port} to free';` +
    `$end=(Get-Date).AddSeconds(20);` +
    `while(((Get-Date) -lt $end) -and (Get-NetTCPConnection -LocalPort ${port} -State Listen)){ Start-Sleep -Milliseconds 200 };` +
    `$up=$false;` +
    `for($t=0; $t -lt 5 -and -not $up; $t++){ L ('launch attempt '+($t+1)); ${cfg.restartCommand}; for($i=0;$i -lt 30;$i++){ Start-Sleep -Milliseconds 500; if(Get-NetTCPConnection -LocalPort ${port} -State Listen){ $up=$true; break } } };` +
    `L ('done up='+$up)`;
  // -EncodedCommand (UTF-16LE base64) carries the script with zero nested-quote
  // hazards and dodges the script-execution policy.
  const encoded = Buffer.from(restarter, "utf16le").toString("base64");

  // Launch it so it SURVIVES this process exiting. The old reboot silently did
  // nothing (reboot.log stayed empty — the restarter never wrote its first
  // line): the prime suspect is the quote/`$`/`;`-heavy script passed through
  // `-Command`, which Node's Windows arg-quoting mangles into an unparseable
  // command. -EncodedCommand (below) removes that hazard entirely. We create the
  // restarter through WMI Win32_Process.Create — which parents it under
  // WmiPrvSE rather than this process — as belt-and-suspenders so it can't be
  // torn down with us however this bridge is supervised (today the Task
  // Scheduler task is fire-and-forget and the node tree is orphaned, but that's
  // not something to depend on). A detached spawn is the fallback. base64 is
  // quote-free, so single-quoting the CommandLine is safe.
  const childCmd = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`;
  const wmi =
    `try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
    `-Arguments @{ CommandLine = '${childCmd}' } -ErrorAction Stop; ` +
    `if ($r.ReturnValue -ne 0) { exit 1 }; exit 0 } catch { exit 2 }`;
  let launched = false;
  try {
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wmi], {
      windowsHide: true,
      timeout: 10_000,
    });
    launched = res.status === 0;
    if (!launched) log.warn({ status: res.status }, "reboot: WMI restarter did not confirm — falling back to detached spawn");
  } catch (err) {
    log.warn({ err: String(err) }, "reboot: WMI restarter threw — falling back to detached spawn");
  }
  if (!launched) {
    // Fallback for standalone/dev runs (no kill-on-close job to escape): a
    // plain detached, unref'd child. It can't survive a Task Scheduler job
    // close — but without WMI, nothing could.
    try {
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch (err) {
      log.error({ err: String(err) }, "reboot: could not spawn the restarter — staying up");
      return; // never exit if the relaunch couldn't be scheduled, or the deck stays dead
    }
  }
  // Give the restarter a beat to come up and start logging, then exit so its
  // port-wait unblocks and it relaunches us.
  setTimeout(() => process.exit(0), 600);
}

controller.setHooks({
  onReboot: rebootBridge,
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
  onPermissionDefer: () => {
    // A console plan was answered by keystroke; release the held request with
    // {} so the morph layer dismisses. The decision is moot — Claude already
    // exited (or stayed in) plan mode via the menu.
    decisions.decide("show-on-screen");
  },
  onQuestionKey: (optionIndex) => {
    const q = layer.question;
    if (!q) return;
    const options = currentQuestion(q).options;
    const absolute = q.page * QUESTION_OPTIONS_PER_PAGE + optionIndex;
    if (absolute >= options.length) return;
    // Multi-select: each option key is a checkbox — toggle it and wait for the
    // Submit key, instead of answering-and-advancing on a single press.
    if (currentQuestion(q).multiSelect) {
      const checked = (q.checked ??= []);
      const at = checked.indexOf(absolute);
      if (at === -1) checked.push(absolute);
      else checked.splice(at, 1);
      pushRender();
      return;
    }
    const session = registry.get(q.sessionId);
    if (!session) return revertQuestion();
    // Advance the layer NOW, not after the keystrokes land. Claude Code has
    // already rendered the next question by the time a human reaches for the
    // next key, and leaving the answered one on screen invites a double press.
    const more = advanceQuestion(q);
    // Only the LAST answer finishes the form; earlier ones just advance. The
    // menu is arrow-navigated (see deliverQuestionAnswer): a multi-question ask
    // ends on a "Submit answers" step, a single-question ask submits on the
    // chosen option's own Enter.
    const isLast = !more;
    const multi = q.questions.length > 1;
    if (more) {
      syncFlash(flashNeeded());
      pushRender();
    } else {
      revertQuestion();
    }
    void (async () => {
      const ok = await deliverQuestionAnswer(delivery, session, absolute + 1, isLast, multi);
      log.info(
        { session: q.sessionId, option: options[absolute], isLast, multi, ok },
        "question answered from deck",
      );
    })();
  },
  onQuestionPager: () => {
    const q = layer.question;
    if (!q) return;
    // Multi-select: this key is "Submit" — ship the toggled set, then advance
    // (or finish) exactly like a single answer would.
    if (currentQuestion(q).multiSelect) {
      const session = registry.get(q.sessionId);
      if (!session) return revertQuestion();
      const checked = [...(q.checked ?? [])];
      const more = advanceQuestion(q);
      const isLast = !more;
      const multi = q.questions.length > 1;
      if (more) {
        q.checked = [];
        syncFlash(flashNeeded());
        pushRender();
      } else {
        revertQuestion();
      }
      void (async () => {
        const ok = await deliverMultiSelectAnswer(delivery, session, checked, isLast, multi);
        log.info({ session: q.sessionId, picked: checked.length, isLast, multi, ok }, "multi-select answered from deck");
      })();
      return;
    }
    const pages = Math.ceil(currentQuestion(q).options.length / QUESTION_OPTIONS_PER_PAGE);
    if (pages > 1) {
      q.page = (q.page + 1) % pages;
      pushRender();
    } else {
      // Single page → the key is "Cancel": hand back to the screen. Cancels
      // the WHOLE ask, remaining questions included — they're all still live
      // in the console, which is exactly where you just chose to answer them.
      revertQuestion();
    }
  },
});

registry.on("changed", () => {
  syncFlash(flashNeeded());
  syncSlowPulse();
  pushRender();
});

/** Claude Code's status vocabulary → the deck's. */
function ccStatusToDeck(status: string | undefined): SessionStatus | undefined {
  if (status === "busy") return "thinking";
  if (status === "waiting" || status === "needs_trust") return "waiting";
  if (status === "idle") return "idle";
  return undefined;
}

/**
 * Reconcile the deck against every live terminal Claude Code knows about:
 * bind ones we've heard from, and SURFACE ones we haven't. An interactive
 * session fires no SessionStart, so an idle terminal never announces itself —
 * without this it has no key until someone types in it.
 */
function adoptTerminals(only?: SessionEntry): void {
  const cli = readCliSessions(CC_SESSIONS_DIR, log);
  for (const meta of cli) {
    const known = registry.get(meta.sessionId);
    if (known) {
      if (only && known.sessionId !== only.sessionId) continue;
      const had = known.pid;
      if (registry.adoptTerminal(meta.sessionId, meta.pid)) {
        // A CHANGED pid means the key was driving the wrong console until now
        // — worth a warning, not an info line, because the symptom (commands
        // landing in another session) is bewildering from the outside.
        if (had !== undefined) {
          log.warn(
            { session: meta.sessionId, label: known.label, was: had, now: meta.pid },
            "corrected a crossed console binding from Claude Code's own record",
          );
        } else {
          log.info({ session: meta.sessionId, label: known.label, pid: meta.pid }, "adopted terminal session by pid");
        }
      }
      continue;
    }
    if (only) continue; // arrival pass only enriches the session that arrived
    // Only surface sessions actually in use. A claude process can outlive the
    // work by days without exiting, and a key for something abandoned last
    // Tuesday is noise — reuse the same staleness threshold that dims a key.
    if (Date.now() - meta.updatedAt > cfg.staleSessionMinutes * 60_000) continue;
    // A restored provisional key (from a persisted console binding) covers this
    // tree — reconcile the real session INTO it (swap its launching:* id, bind
    // the pid, carry the name) rather than skipping and stranding a phantom
    // beside a would-be duplicate. Interactive sessions fire no hook, so this
    // adopt pass is the only place that reconciliation can happen for them.
    const reconciled = registry.adoptProvisionalTerminal({
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      pid: meta.pid,
      name: meta.name,
      status: ccStatusToDeck(meta.status),
    });
    if (reconciled) {
      log.info({ session: meta.sessionId, label: reconciled.label, pid: meta.pid }, "reconciled provisional into terminal session");
      continue;
    }
    // One key per live CONSOLE — identified by pid, not by directory.
    //
    // A terminal accumulates several Claude Code sessions over its life
    // (restarts, dispatched jobs) all sharing one console, and the deck should
    // show the console rather than its history — but they share that console's
    // PID, which is what makes them the same thing. Directory is not identity:
    // `Resume` deliberately creates no worktree, so resuming four sessions into
    // one repo gives four distinct consoles in ONE cwd. Keying on the tree made
    // the first of them "cover" the rest, and three real consoles silently had
    // no key at all until someone typed in them.
    //
    // The provisional clause stays: a launch still in flight owns its tree, and
    // the session that eventually starts there belongs to that key (it
    // reconciles above), so it must not also get a second one here.
    const covered = registry
      .all()
      .some(
        (s) =>
          (meta.pid !== undefined && s.pid === meta.pid) ||
          (s.sessionId.startsWith("launching:") &&
            (pathWithin(meta.cwd ?? "", s.cwd) || pathWithin(s.cwd, meta.cwd ?? ""))),
      );
    if (covered) continue;
    const added = registry.addKnownTerminal({ ...meta, status: ccStatusToDeck(meta.status) });
    if (added) {
      log.info({ session: meta.sessionId, label: added.label, pid: meta.pid }, "surfaced terminal session from Claude Code metadata");
    }
  }
}
/**
 * Catch prompts NO HOOK REPORTS.
 *
 * Claude Code's hook vocabulary covers its own dialogs (PermissionRequest,
 * AskUserQuestion, the idle/permission Notifications) but not everything that
 * blocks a session on the human: an MCP server's elicitation ("Are you sure you
 * want to execute dax queries…?") raises no hook at all, so the deck never
 * learned the session was stuck and the key sat there looking fine.
 *
 * It does, however, publish `status: "waiting"` into its own session file
 * whenever something is blocking on input — the same file the row-2 command
 * guard already reads to refuse typing into a prompt. That signal was being
 * read and used only to say NO; this promotes it to the deck as well.
 *
 * PROMOTE-ONLY, deliberately: it can raise a session to waiting but never lower
 * one, so hooks keep ownership of every other transition and the next real
 * activity clears it. Idle-at-the-prompt reports "idle", not "waiting", so a
 * console merely sitting there does not light up.
 *
 * Covers DESKTOP-app sessions as well as terminals: being stuck is worth
 * showing wherever the session lives, and only delivery needs a console pid
 * (see readWaitingSessionIds).
 */
function pollPromptWaiting(): void {
  for (const sessionId of readWaitingSessionIds(CC_SESSIONS_DIR, log)) {
    const entry = registry.get(sessionId);
    if (!entry || entry.status === "waiting") continue;
    registry.setStatus(entry, "waiting");
    log.info(
      { session: sessionId, label: entry.label, kind: entry.windowKind },
      "session is blocked at a prompt the deck gets no hook for — surfacing it",
    );
  }
}
setInterval(pollPromptWaiting, 5_000).unref();

registry.on("session-added", (entry: SessionEntry) => adoptTerminals(entry));
adoptTerminals(); // catch everything already running at boot

// Re-stock the spare worktree for every repo the deck already spawns into, so
// the first New after a restart is as fast as the rest. Spares survive on
// disk, so this is usually a no-op.
if (cfg.newSessionWorktrees) {
  for (const cwd of new Set(registry.all().map((s) => s.cwd))) void launcher.prewarmFor(cwd);
}

registerHookRoutes(app, registry, log, {
  onPermissionRequest: (event) => decisions.hold(event),
  onSessionEnd: (sessionId) => decisions.releaseSession(sessionId),
  onQuestion: (event) => showQuestion(event),
  onTurnEnded: (sessionId, lastMessage) => void readTurnOptions(sessionId, lastMessage),
  onAnyEvent: (sessionId, eventName) => {
    // Real activity from the asking session means the question was answered
    // (on screen or via the deck) or abandoned. Notification is NOT activity —
    // see endsPendingQuestion.
    if (!endsPendingQuestion(eventName)) return;
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

log.info({ port: cfg.port }, `Conn bridge up — web deck at http://127.0.0.1:${cfg.port}/`);

// Periodic sweep: re-derive labels (branch renames reach the buttons), skull
// and demote dead-window sessions (3h TTL sweep), refresh stale dimming.
setInterval(() => {
  // Claude Code's own `/rename` reaches the button here (its session
  // metadata is the only place that name is published).
  registry.refreshLabels(readCcSessionNames(CC_SESSIONS_DIR, log));
  adoptTerminals();
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
