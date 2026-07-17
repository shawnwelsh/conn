import type { SessionRegistry } from "./registry.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { Logger } from "./log.js";

/**
 * Dead-window detection: sessions with a bound HWND whose window no longer
 * exists (closed/crashed without a clean SessionEnd) get skulled and demoted;
 * after `ttlMs` they're swept from the registry entirely.
 *
 * Only an explicit "not alive" from the adapter marks a session dead —
 * unknown (null) never does, so a daemon hiccup can't skull a live session.
 */
export async function livenessSweep(
  registry: SessionRegistry,
  delivery: DeliveryAdapter,
  ttlMs: number,
  log: Logger,
): Promise<void> {
  for (const session of registry.all()) {
    if (!session.hwnd || session.windowDead) continue;
    const alive = await delivery.checkWindow(session.hwnd);
    if (alive === false) {
      log.warn({ session: session.sessionId, label: session.label, hwnd: session.hwnd }, "window dead — skulling");
      registry.markWindowDead(session.sessionId);
    }
  }
  registry.sweepDead(ttlMs);
}
