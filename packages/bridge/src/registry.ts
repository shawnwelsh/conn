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
  working: string[];
  overflow: string[];
  pagerActive: boolean;
  pagerFlash: boolean;
}

/**
 * Owns the deck's session model:
 *  - `working`: the visible agent slots, in slot order. Stable — targeting or
 *    using a working session never reorders them.
 *  - `overflow`: everything else, most-recently-used first, browsed via the
 *    pager. Capped at `maxTracked` total sessions (LRU-evicted beyond that).
 *
 * When >slotCount sessions are tracked, the last slot becomes the Pager and
 * the working set shrinks by one (slotCount-1). A single overflow session that
 * needs attention surfaces into slot #4; multiple set `pagerFlash`.
 */
export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  private working: string[] = [];
  private overflow: string[] = []; // MRU: index 0 = most recent
  private targeted: string | null = null;
  private pagerFlash = false;

  constructor(
    private readonly slotCount: number,
    private readonly maxTracked = 15,
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

  /** True when the pager occupies the last slot (more sessions than slots). */
  pagerActive(): boolean {
    return this.sessions.size > this.slotCount;
  }

  pagerFlashing(): boolean {
    return this.pagerFlash;
  }

  /** Working-set size: one fewer than slotCount while the pager is shown. */
  private capacity(): number {
    return this.pagerActive() ? this.slotCount - 1 : this.slotCount;
  }

  bySlot(slot: number): SessionEntry | undefined {
    const id = this.working[slot];
    return id ? this.sessions.get(id) : undefined;
  }

  /** Overflow entries in MRU order (for the pager). */
  overflowEntries(): SessionEntry[] {
    return this.overflow.map((id) => this.sessions.get(id)!).filter(Boolean);
  }

  get targetedSession(): SessionEntry | undefined {
    return this.targeted ? this.sessions.get(this.targeted) : undefined;
  }

  ensure(event: AnyHookEvent): SessionEntry {
    let entry = this.sessions.get(event.session_id);
    if (!entry) {
      entry = {
        sessionId: event.session_id,
        slot: -1,
        label: deriveLabel(event.cwd),
        cwd: event.cwd ?? "",
        status: "idle",
        lastEventAt: Date.now(),
        events: new RingBuffer(this.eventHistorySize),
      };
      this.sessions.set(event.session_id, entry);
      this.place(entry.sessionId);
      if (!this.targeted) this.targeted = entry.sessionId;
      this.emit("changed");
    }
    return entry;
  }

  recordEvent(entry: SessionEntry, event: string, detail?: string): void {
    entry.lastEventAt = Date.now();
    entry.events.push({ at: Date.now(), event, detail });
    // MRU: any activity floats an overflow session to the front (working
    // sessions never reorder).
    const i = this.overflow.indexOf(entry.sessionId);
    if (i > 0) {
      this.overflow.splice(i, 1);
      this.overflow.unshift(entry.sessionId);
      this.emit("changed");
    }
  }

  setStatus(entry: SessionEntry, status: SessionStatus): void {
    if (entry.status === status) return;
    entry.status = status;
    if (status === "waiting") this.trySurface(entry.sessionId);
    // Flash the pager iff an overflow session is still waiting — i.e. one that
    // couldn't surface because the attention slot is already busy.
    this.pagerFlash = this.overflow.some((id) => this.sessions.get(id)?.status === "waiting");
    this.emit("changed");
  }

  release(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.working = this.working.filter((s) => s !== sessionId);
    this.overflow = this.overflow.filter((s) => s !== sessionId);
    if (this.targeted === sessionId) this.targeted = this.working[0] ?? this.overflow[0] ?? null;
    this.rebalance();
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

  /** Pager browse-pick: bring a session to slot #1 and target it. */
  promoteToFront(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.working = this.working.filter((s) => s !== sessionId);
    this.overflow = this.overflow.filter((s) => s !== sessionId);
    this.working.unshift(sessionId);
    this.targeted = sessionId;
    this.rebalance();
    this.emit("changed");
  }

  /** Long-press move: place a session at a working slot, insert-before style.
   * e.g. moveToSlot(A, 2) on [A,B,C,D] → [B,C,A,D]. */
  moveToSlot(sessionId: string, targetIndex: number): void {
    if (!this.sessions.has(sessionId)) return;
    this.working = this.working.filter((s) => s !== sessionId);
    this.overflow = this.overflow.filter((s) => s !== sessionId);
    const idx = Math.max(0, Math.min(targetIndex, this.working.length));
    this.working.splice(idx, 0, sessionId);
    this.rebalance();
    this.emit("changed");
  }

  clearPagerFlash(): void {
    if (this.pagerFlash) {
      this.pagerFlash = false;
      this.emit("changed");
    }
  }

  snapshot(): RegistrySnapshot {
    return {
      sessions: this.all().map((s) => ({ ...s, events: s.events.toArray() })),
      targetedSessionId: this.targeted,
      working: [...this.working],
      overflow: [...this.overflow],
      pagerActive: this.pagerActive(),
      pagerFlash: this.pagerFlash,
    };
  }

  /** Place a newly-tracked session: into working if room, else overflow front. */
  private place(sessionId: string): void {
    if (this.working.length < this.capacity()) this.working.push(sessionId);
    else this.overflow.unshift(sessionId);
    this.rebalance();
  }

  /** Surface a waiting overflow session into the attention slot (#4) — unless
   * that slot already holds a different waiting session, in which case it
   * stays in overflow and the pager flashes (handled by the caller). */
  private trySurface(sessionId: string): void {
    if (!this.overflow.includes(sessionId)) return;
    const idx = this.capacity() - 1;
    const slot4 = this.working[idx];
    const slot4Busy = slot4 !== undefined && slot4 !== sessionId && this.sessions.get(slot4)?.status === "waiting";
    if (!slot4Busy) this.surfaceToLastSlot(sessionId);
  }

  private surfaceToLastSlot(sessionId: string): void {
    this.overflow = this.overflow.filter((s) => s !== sessionId);
    const idx = this.capacity() - 1;
    if (this.working.length > idx) {
      this.overflow.unshift(this.working[idx]!); // displaced → overflow front
      this.working[idx] = sessionId;
    } else {
      this.working.push(sessionId);
    }
    this.rebalance();
  }

  /** Enforce capacity, fill freed slots from overflow, cap total, sync slots. */
  private rebalance(): void {
    const cap = this.capacity();
    while (this.working.length > cap) this.overflow.unshift(this.working.pop()!);
    while (this.working.length < cap && this.overflow.length > 0) this.working.push(this.overflow.shift()!);
    // Cap total tracked sessions — drop the least-recently-used overflow tail.
    while (this.sessions.size > this.maxTracked && this.overflow.length > 0) {
      const victim = this.overflow.pop()!;
      this.sessions.delete(victim);
      if (this.targeted === victim) this.targeted = this.working[0] ?? this.overflow[0] ?? null;
    }
    this.syncSlots();
  }

  private syncSlots(): void {
    for (const entry of this.sessions.values()) entry.slot = this.working.indexOf(entry.sessionId);
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
