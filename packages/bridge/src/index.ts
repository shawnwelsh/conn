import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { SessionRegistry } from "./registry.js";
import { DecisionStore } from "./decisions.js";
import { computeTiles, type DeckLayerState } from "./layers.js";
import { renderTile, toDataUri } from "./render/tile.js";
import { DeckSocketServer } from "./ws/server.js";
import { DeckController } from "./controller.js";
import { NoopAdapter } from "./delivery/adapter.js";
import { registerHookRoutes } from "./http/hooks.js";
import { registerApiRoutes } from "./http/api.js";
import type { KeyRender } from "@claude-deck/shared";

const cfg = loadConfig();
const log = createLogger(cfg);
const registry = new SessionRegistry(cfg.slots);
const layer: DeckLayerState = { row2: "idle" };

const delivery = new NoopAdapter((method, detail) =>
  log.warn({ method, detail }, "delivery unavailable (noop adapter — Phase 3)"),
);

const app = Fastify({ logger: false });

let sockets: DeckSocketServer;
let lastImages: string[] = [];
let flashPhase = false;
let flashTimer: ReturnType<typeof setInterval> | null = null;

/** Render loop: recompute all 15 tiles, broadcast only the ones that changed.
 * The tile cache makes unchanged tiles nearly free to recompute. */
function pushRender(): void {
  const tiles = computeTiles(registry, layer, cfg, flashPhase);
  const images = tiles.map((t) => toDataUri(renderTile(t)));
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
);

/** Keep the row-2 layer in lockstep with the decision queue and run the
 * flash animation only while something is pending. */
function syncPermissionLayer(): void {
  const current = decisions.current;
  if (current) {
    layer.row2 = "permission";
    layer.permission = {
      sessionId: current.sessionId,
      toolName: current.toolName,
      summary: current.summary,
    };
    registry.target(current.sessionId); // auto-target the requester
    if (!flashTimer) {
      flashTimer = setInterval(() => {
        flashPhase = !flashPhase;
        pushRender();
      }, 500);
    }
  } else if (layer.row2 === "permission") {
    layer.row2 = "idle";
    layer.permission = undefined;
    if (flashTimer) {
      clearInterval(flashTimer);
      flashTimer = null;
      flashPhase = false;
    }
  }
  pushRender();
}

const controller = new DeckController(registry, layer, delivery, cfg, log, pushRender);
controller.setHooks({
  onPermissionKey: (index) => {
    const action = (["allow", "always-allow", "deny", "deny-reason", "show-on-screen"] as const)[index];
    if (!action) return;
    const settled = decisions.decide(action);
    if (settled && action === "show-on-screen") {
      const session = registry.get(settled.sessionId);
      if (session) void delivery.focus(session);
    }
  },
});

registry.on("changed", () => pushRender());

registerHookRoutes(app, registry, log, {
  onPermissionRequest: (event) => decisions.hold(event),
  onSessionEnd: (sessionId) => decisions.releaseSession(sessionId),
});
await registerApiRoutes(app, registry, layer);

await app.listen({ port: cfg.port, host: "127.0.0.1" });

sockets = new DeckSocketServer(
  app.server,
  log,
  (slot) => controller.press(slot),
  (count) => log.info({ count }, "deck clients"),
);
pushRender();

log.info({ port: cfg.port }, `claude-deck bridge up — web deck at http://127.0.0.1:${cfg.port}/`);

// Periodic re-render so stale-session dimming (Phase 3) and clock-driven
// states can refresh without an inbound event.
setInterval(() => pushRender(), 30_000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    void delivery.dispose().finally(() => process.exit(0));
  });
}
