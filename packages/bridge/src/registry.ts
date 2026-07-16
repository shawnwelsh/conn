import { EventEmitter } from "node:events";
import { basename, join, resolve, isAbsolute, dirname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { SessionStatus } from "@claude-deck/shared";
import { RingBuffer } from "./log.js";
import type { AnyHookEvent } from "./hookTypes.js";

export interface SessionEntry {
  sessionId: string;
  slot: number; // 0..slots-1, or -1 when overflowed
  label: string;
  cwd: string;
  status: SessionStatus;
  lastEventAt: number;
  /** Last tool activity summary, for future badge rendering. */
  lastTool?: string;
  /** Live session settings, captured from hook payloads — the source of
   * truth for stateful mode/effort/model keys. */
  permissionMode?: string;
  effortLevel?: string;
  model?: string;
  events: RingBuffer<{ at: number; event: string; detail?: string }>;
}

export interface RegistrySnapshot {
  sessions: Array<Omit<SessionEntry, "events"> & { events: readonly unknown[] }>;
  targetedSessionId: string | null;
  overflow: string[];
}

/**
 * Owns session → slot assignment and targeting. Emits "changed" whenever
 * anything render-relevant moves; the render loop subscribes.
 */
export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  private targeted: string | null = null;

  constructor(
    private readonly slotCount: number,
    private readonly eventHistorySize = 200,
  ) {
    super();
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  all(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  bySlot(slot: number): SessionEntry | undefined {
    return this.all().find((s) => s.slot === slot);
  }

  get targetedSession(): SessionEntry | undefined {
    return this.targeted ? this.sessions.get(this.targeted) : undefined;
  }

  /** Returns the session, creating + slotting it if new. */
  ensure(event: AnyHookEvent): SessionEntry {
    let entry = this.sessions.get(event.session_id);
    if (!entry) {
      entry = {
        sessionId: event.session_id,
        slot: this.claimSlot(),
        label: deriveLabel(event.cwd),
        cwd: event.cwd ?? "",
        status: "idle",
        lastEventAt: Date.now(),
        events: new RingBuffer(this.eventHistorySize),
      };
      this.sessions.set(event.session_id, entry);
      // First session to appear becomes the target automatically.
      if (!this.targeted) this.targeted = entry.sessionId;
      this.emit("changed");
    }
    return entry;
  }

  recordEvent(entry: SessionEntry, event: string, detail?: string): void {
    entry.lastEventAt = Date.now();
    entry.events.push({ at: Date.now(), event, detail });
  }

  setStatus(entry: SessionEntry, status: SessionStatus): void {
    if (entry.status !== status) {
      entry.status = status;
      this.emit("changed");
    }
  }

  release(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    if (this.targeted === sessionId) {
      this.targeted = this.all().find((s) => s.slot >= 0)?.sessionId ?? null;
    }
    this.promoteOverflow();
    this.emit("changed");
  }

  target(sessionId: string): void {
    if (this.sessions.has(sessionId) && this.targeted !== sessionId) {
      this.targeted = sessionId;
      this.emit("changed");
    }
  }

  targetSlot(slot: number): SessionEntry | undefined {
    const entry = this.bySlot(slot);
    if (entry) this.target(entry.sessionId);
    return entry;
  }

  snapshot(): RegistrySnapshot {
    return {
      sessions: this.all().map((s) => ({ ...s, events: s.events.toArray() })),
      targetedSessionId: this.targeted,
      overflow: this.all().filter((s) => s.slot < 0).map((s) => s.sessionId),
    };
  }

  private claimSlot(): number {
    const used = new Set(this.all().map((s) => s.slot));
    for (let i = 0; i < this.slotCount; i++) if (!used.has(i)) return i;
    // All slots taken: evict the oldest "done" session, else overflow.
    const evictable = this.all()
      .filter((s) => s.slot >= 0 && s.status === "done")
      .sort((a, b) => a.lastEventAt - b.lastEventAt)[0];
    if (evictable) {
      const slot = evictable.slot;
      evictable.slot = -1;
      return slot;
    }
    return -1;
  }

  private promoteOverflow(): void {
    const used = new Set(this.all().map((s) => s.slot));
    for (let i = 0; i < this.slotCount; i++) {
      if (used.has(i)) continue;
      const waiting = this.all()
        .filter((s) => s.slot < 0)
        .sort((a, b) => a.lastEventAt - b.lastEventAt)[0];
      if (!waiting) return;
      waiting.slot = i;
      used.add(i);
    }
  }
}

/**
 * A human "feature name" for the session. Worktree dirs are auto-generated
 * codenames (dazzling-williams-cb6de4) and session_title is empty at
 * SessionStart, so the branch is the meaningful name:
 *   claude/stream-deck-claude-code-736eec → "stream deck claude code"
 * Falls back to the cwd leaf for non-git dirs or main/master checkouts.
 */
export function deriveLabel(cwd: string | undefined): string {
  if (!cwd) return "session";
  const branch = gitBranch(cwd);
  if (branch && !["main", "master", "HEAD", "develop"].includes(branch)) {
    const pretty = prettifyBranch(branch);
    if (pretty) return pretty;
  }
  return basename(cwd.replace(/[\\/]+$/, "")) || "session";
}

/** Read the current branch by walking up to the repo's .git (file or dir),
 * following worktree gitdir pointers. No subprocess — avoids git index locks. */
function gitBranch(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    const dotgit = join(dir, ".git");
    try {
      const st = statSync(dotgit);
      let gitDir = dotgit;
      if (st.isFile()) {
        const m = readFileSync(dotgit, "utf8").trim().match(/^gitdir:\s*(.+)$/);
        if (!m) return null;
        gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
      }
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      const rm = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      return rm ? rm[1]! : null; // detached HEAD → no branch name
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/** claude/stream-deck-...-736eec → "stream deck ...": drop the namespace
 * prefix, a trailing short hash, and a trailing ISO date; hyphens→spaces. */
export function prettifyBranch(branch: string): string {
  let leaf = branch.split("/").pop() ?? branch;
  leaf = leaf.replace(/-[0-9a-f]{6,}$/i, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return leaf.replace(/[-_]+/g, " ").trim();
}
