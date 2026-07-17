import type { SessionRegistry } from "./registry.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { Logger } from "./log.js";

/**
 * Dead-console detection: bound sessions whose console died (closed/crashed
 * without a clean SessionEnd) get skulled and demoted; after `ttlMs` they're
 * swept from the registry entirely.
 *
 * The PID is the primary signal — a WT-hosted console's window belongs to
 * WindowsTerminal.exe, which outlives (and predates) any one session, so the
 * window proves nothing there. HWND-only sessions keep the window check.
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
    if (session.windowDead || (!session.pid && !session.hwnd)) continue;
    const alive = session.pid
      ? await delivery.checkPid?.(session.pid)
      : await delivery.checkWindow(session.hwnd!);
    if (alive === false) {
      log.warn(
        { session: session.sessionId, label: session.label, pid: session.pid, hwnd: session.hwnd },
        "console dead — skulling",
      );
      registry.markWindowDead(session.sessionId);
    }
  }
  registry.sweepDead(ttlMs);
}
