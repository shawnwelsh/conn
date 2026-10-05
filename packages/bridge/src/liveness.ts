import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRegistry } from "./registry.js";
import { findRepoRoot } from "./delivery/launcher.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { Logger } from "./log.js";

/**
 * Has this session's working directory been DELETED, as opposed to merely
 * unreachable right now?
 *
 * The distinction is the whole point: these repos live on OneDrive, where a
 * path can blink out transiently, and skulling a live session over a blip
 * would be worse than leaving a stale key. So we require corroboration that
 * the surrounding tree is still there — the repo root for a worktree, the
 * parent folder otherwise. A deleted worktree satisfies that; an unmounted
 * volume does not.
 */
export function cwdVanished(cwd: string | undefined): boolean {
  if (!cwd || existsSync(cwd)) return false;
  const root = findRepoRoot(cwd); // resolves even when cwd itself is gone
  return existsSync(root ?? dirname(cwd));
}

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
 *
 * A vanished working directory is the second signal, and the only one that
 * reaches DESKTOP sessions: they carry neither pid nor hwnd, so nothing here
 * ever examined them, and a key whose worktree had been cleaned up sat looking
 * perfectly live. It is deliberately the WEAKEST signal — a session Claude Code
 * still has a process for, or one whose console answers, is never skulled for a
 * missing folder. A console remains typeable after its directory is removed.
 */
export async function livenessSweep(
  registry: SessionRegistry,
  delivery: DeliveryAdapter,
  ttlMs: number,
  log: Logger,
  /** Sessions Claude Code still has a live process for — never skulled. */
  liveSessionIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const session of registry.all()) {
    if (session.windowDead) continue;

    // A BOUND session is judged by its process/window and nothing else. Never
    // fall through to the directory check here: `alive === null` means the
    // daemon could not tell, and the long-standing rule is that unknown never
    // skulls — a hiccup that happened to coincide with a removed folder would
    // otherwise kill a live console, which stays typeable regardless.
    if (session.pid || session.hwnd) {
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
      continue;
    }

    // Unbound — desktop sessions. Nothing above can see them.
    if (liveSessionIds.has(session.sessionId)) continue;
    if (!cwdVanished(session.cwd)) continue;
    log.warn(
      { session: session.sessionId, label: session.label, cwd: session.cwd },
      "working directory is gone and the session is not running — skulling",
    );
    registry.markWindowDead(session.sessionId);
  }
  registry.sweepDead(ttlMs);
}
