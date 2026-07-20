import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log.js";

/**
 * Claude Code's own per-session metadata, which it keeps in
 * `~/.claude/sessions/<pid>.json` while a session is running:
 *
 *   {"pid":92100,"sessionId":"1b299bf2-…","cwd":"…\\worktrees\\brisk-wombat",
 *    "kind":"interactive","name":"Renewal Fix","status":"busy", …}
 *
 * `/rename` (alias `/name`) writes that `name`, which makes it a free naming
 * channel for the deck: name a session in the console and its key follows.
 * Auto-generated names carry `nameSource:"derived"` (they're just the cwd
 * leaf plus a hash — "dazzling-williams-cb6de4-18") and are ignored; the
 * branch-derived label is a better button than that.
 *
 * Read-only and best-effort: this is Claude Code's file, not ours, so a
 * schema change or a locked read degrades to "no external names" rather than
 * breaking the deck.
 *
 * (`/color` sets the prompt bar color for a session but persists NOWHERE we
 * can see — not here, not in ~/.claude.json — so the deck cannot mirror it.)
 */

export const CC_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/**
 * Is this session sitting at a prompt right now, waiting on the human?
 *
 * Claude Code publishes `status: "waiting"` here whenever something is
 * blocking on input (its own code: `if (waitingFor !== undefined) return
 * {status:"waiting", …}`). Read fresh from disk on every call — the whole
 * point is to catch a prompt the deck never witnessed, including one that
 * went up before the bridge started.
 *
 * Returns null when we can't tell (no file, no match, unreadable), which
 * callers must treat as "unknown", not "safe".
 */
export function isAwaitingInput(
  sessionId: string,
  dir: string = CC_SESSIONS_DIR,
  log?: Logger,
): boolean | null {
  // One session can have SEVERAL records under different pids — Claude Code's
  // own lookup checks for `sessionId === e && pid !== process.pid && kind !==
  // "interactive"`, so a dispatched job and its interactive peer can coexist.
  // Taking the first file found would be a coin flip; take the freshest.
  let newest: { at: number; waiting: boolean } | null = null;
  for (const meta of readRecords(dir, log)) {
    if (meta.sessionId !== sessionId) continue;
    const at = typeof meta.statusUpdatedAt === "number" ? meta.statusUpdatedAt : (meta.updatedAt ?? 0);
    if (!newest || at >= newest.at) newest = { at, waiting: meta.status === "waiting" };
  }
  return newest ? newest.waiting : null;
}

interface CcRecord {
  sessionId?: unknown;
  name?: unknown;
  nameSource?: unknown;
  status?: unknown;
  pid?: unknown;
  cwd?: unknown;
  entrypoint?: unknown;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

/**
 * sessionId → pid, for sessions running in a TERMINAL.
 *
 * `entrypoint: "cli"` is Claude Code's own word for "this session is a
 * command-line process", as opposed to `"claude-desktop"` (a tab in the
 * Windows app, which owns no console and must never be injected into). It's
 * authoritative where the deck previously had to guess from "did I launch
 * it?", and it's what lets sessions started by hand become controllable.
 *
 * `kind` is deliberately ignored: a FleetView-dispatched session is "bg" but
 * still a terminal you type in.
 */
export interface CliSession {
  sessionId: string;
  pid: number;
  cwd?: string;
  name?: string;
  /** Claude Code's own status: idle | busy | waiting | needs_trust. */
  status?: string;
}

export function readCliSessions(dir: string = CC_SESSIONS_DIR, log?: Logger): CliSession[] {
  const byId = new Map<string, { at: number; session: CliSession }>();
  for (const meta of readRecords(dir, log)) {
    if (typeof meta.sessionId !== "string") continue;
    if (meta.entrypoint !== "cli") continue;
    if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 0) continue;
    if (!isRunning(meta.pid)) continue; // records outlive their processes
    const at = meta.updatedAt ?? 0;
    const prev = byId.get(meta.sessionId);
    if (prev && at < prev.at) continue;
    byId.set(meta.sessionId, {
      at,
      session: {
        sessionId: meta.sessionId,
        pid: meta.pid,
        cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
        name: meta.nameSource === "derived" || typeof meta.name !== "string" ? undefined : meta.name.trim(),
        status: typeof meta.status === "string" ? meta.status : undefined,
      },
    });
  }
  return [...byId.values()].map((v) => v.session);
}

/** Cheap liveness check — signal 0 tests existence without touching the
 * process. EPERM means it exists but belongs to someone else. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every readable record in the directory. Malformed files are skipped, not
 * fatal — this is Claude Code's file, and its shape is not our contract. */
function readRecords(dir: string, log?: Logger): CcRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CcRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as CcRecord);
    } catch (err) {
      log?.debug({ file, err: String(err) }, "session meta: unreadable, skipped");
    }
  }
  return out;
}

/** sessionId → the human name a user (or Claude) gave the conversation.
 * Duplicate records for one session resolve to the freshest, so a stale peer
 * can't flip the label back and forth on the 30s sweep. */
export function readCcSessionNames(dir: string = CC_SESSIONS_DIR, log?: Logger): Map<string, string> {
  const names = new Map<string, string>();
  const seenAt = new Map<string, number>();
  for (const meta of readRecords(dir, log)) {
    if (typeof meta.sessionId !== "string" || typeof meta.name !== "string") continue;
    if (meta.nameSource === "derived") continue; // cwd-derived filler, not a name
    const name = meta.name.trim();
    if (!name) continue;
    const at = meta.updatedAt ?? 0;
    if (seenAt.has(meta.sessionId) && at < seenAt.get(meta.sessionId)!) continue;
    seenAt.set(meta.sessionId, at);
    names.set(meta.sessionId, name);
  }
  return names;
}
