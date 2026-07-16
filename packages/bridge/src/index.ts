import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { SessionRegistry } from "./registry.js";
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

/** Render loop: recompute all 15 tiles, broadcast only the ones that changed.
 * The tile cache makes unchanged tiles nearly free to recompute. */
function pushRender(): void {
  const tiles = computeTiles(registry, layer, cfg);
  const images = tiles.map((t) => toDataUri(renderTile(t)));
  const changed: KeyRender[] = [];
  images.forEach((image, slot) => {
    if (image !== lastImages[slot]) changed.push({ slot, image });
  });
  lastImages = images;
  const full = images.map((image, slot) => ({ slot, image }));
  sockets.broadcast(changed, full);
}

const controller = new DeckController(registry, layer, delivery, cfg, log, pushRender);

registry.on("changed", () => pushRender());

registerHookRoutes(app, registry, log, {
  // Phase 1: permission requests are logged, set status=waiting via the
  // registry, and defer immediately. Phase 2 replaces this with the held
  // decision store.
  onPermissionRequest: async () => ({}),
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
