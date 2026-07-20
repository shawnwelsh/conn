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
  /** Label before duplicate-disambiguation — compared on refresh so a branch
   * rename updates the button without suffixes flapping. */
  labelBase: string;
  /** Manual name from the deck's Rename key, for sessions whose branch we
   * can't (or shouldn't) rename. Wins over branch derivation forever —
   * refreshLabels leaves it alone. */
  labelOverride?: string;
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
  /**
   * Where this session's UI lives, which decides the command dialect:
   *  - "console": own terminal window (deck-launched, HWND-bound) — TUI
   *    keystrokes (Shift+Tab, typed /model), precise focus.
   *  - "desktop": a tab in the Claude desktop app — picker chords
   *    (Ctrl+Shift+M/I + number), app-level focus.
   * Unknown sessions default to "desktop" behavior.
   */
  windowKind: "console" | "desktop";
  hwnd?: number;
  pid?: number;
  /** Trailing offer from the last finished turn ("Want me to X?"),
   * surfaced on the deck for console sessions. Cleared on new activity. */
  suggestion?: string;
  /** The bound window died (no clean SessionEnd) — rendered with a skull,
   * demoted to the end of the overflow line, swept after a TTL. */
  windowDead?: boolean;
  deadAt?: number;
  events: RingBuffer<{ at: number; event: string; detail?: string }>;
}

/** A console spawned by the deck, awaiting its session's first hook. */
export interface PendingLaunch {
  cwd: string;
  pid: number;
  hwnd: number | null;
  at: number;
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
  private pendingLaunches: PendingLaunch[] = [];

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
      // A deck-spawned console already holds a provisional key for this cwd —
      // adopt it in place rather than creating a duplicate.
      const adopted = this.adoptProvisional(event);
      if (adopted) return adopted;
    }
    if (!entry) {
      // Disambiguate duplicate feature names (e.g. two sessions in the same
      // worktree/branch): second one becomes "name 2", then "name 3", …
      const base = deriveLabel(event.cwd);
      entry = {
        sessionId: event.session_id,
        slot: -1,
        label: this.dedupeLabel(base, event.session_id),
        labelBase: base,
        cwd: event.cwd ?? "",
        status: "idle",
        lastEventAt: Date.now(),
        windowKind: "desktop",
        events: new RingBuffer(this.eventHistorySize),
      };
      this.sessions.set(event.session_id, entry);
      this.consumePendingLaunch(entry);
      this.place(entry.sessionId);
      if (!this.targeted) this.targeted = entry.sessionId;
      this.emit("changed");
    }
    return entry;
  }

  /** Record a deck-spawned console so the next session starting in that cwd
   * binds to its window. */
  registerPendingLaunch(launch: PendingLaunch): void {
    this.pendingLaunches.push(launch);
  }

  private provisionalSeq = 0;

  /**
   * Claim a key for a console launch the INSTANT it's requested — before the
   * worktree exists or anything spawns. Claude Code fires no SessionStart at
   * interactive launch (observed on 2.1.211: a session's first hook is its
   * first prompt/tool event), so this provisional entry is the only way a
   * fresh console is visible before the user types. It's enriched via
   * bindProvisional/repointProvisional as the launch progresses, and adopted
   * in place when the real session's first hook arrives from that cwd.
   */
  addProvisionalAt(cwd: string): SessionEntry {
    const id = `launching:${++this.provisionalSeq}`;
    const base = deriveLabel(cwd);
    const entry: SessionEntry = {
      sessionId: id,
      slot: -1,
      label: this.dedupeLabel(base, id),
      labelBase: base,
      cwd,
      status: "idle",
      lastEventAt: Date.now(),
      windowKind: "console",
      events: new RingBuffer(this.eventHistorySize),
    };
    this.sessions.set(id, entry);
    this.place(id);
    // Pressing New means your attention is headed there — target it.
    this.targeted = id;
    this.emit("changed");
    return entry;
  }

  /** Attach the spawned process/window to a provisional entry. */
  bindProvisional(cwd: string, bind: { pid: number; hwnd: number | null }): void {
    const entry = this.findProvisional(cwd);
    if (!entry) return;
    entry.pid = bind.pid;
    if (bind.hwnd) entry.hwnd = bind.hwnd;
    this.emit("changed");
  }

  /** Worktree creation fell back — the console will spawn elsewhere. */
  repointProvisional(oldCwd: string, newCwd: string): void {
    const entry = this.findProvisional(oldCwd);
    if (!entry) return;
    entry.cwd = newCwd;
    entry.labelBase = deriveLabel(newCwd);
    entry.label = this.dedupeLabel(entry.labelBase, entry.sessionId);
    this.emit("changed");
  }

  /** The launch failed outright — take the key back. */
  dropProvisional(cwd: string): void {
    const entry = this.findProvisional(cwd);
    if (entry) this.release(entry.sessionId);
  }

  private findProvisional(cwd: string): SessionEntry | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.sessionId.startsWith("launching:") && samePath(entry.cwd, cwd)) return entry;
    }
    return undefined;
  }

  /** Adopt a provisional entry for a real session id: keep its slot/order and
   * window binding, swap the identity. Returns null if none matches. */
  private adoptProvisional(event: AnyHookEvent): SessionEntry | null {
    for (const entry of this.sessions.values()) {
      if (!entry.sessionId.startsWith("launching:")) continue;
      if (!samePath(entry.cwd, event.cwd ?? "")) continue;
      const oldId = entry.sessionId;
      this.sessions.delete(oldId);
      entry.sessionId = event.session_id;
      this.sessions.set(entry.sessionId, entry);
      this.working = this.working.map((id) => (id === oldId ? entry.sessionId : id));
      this.overflow = this.overflow.map((id) => (id === oldId ? entry.sessionId : id));
      if (this.targeted === oldId) this.targeted = entry.sessionId;
      // The matching pending launch is now consumed too.
      this.pendingLaunches = this.pendingLaunches.filter((l) => !samePath(l.cwd, entry.cwd));
      this.emit("changed");
      return entry;
    }
    return null;
  }

  private dedupeLabel(base: string, forSessionId: string): string {
    const taken = new Set(
      this.all().filter((s) => s.sessionId !== forSessionId).map((s) => s.label),
    );
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
    return label;
  }

  /**
   * Re-derive labels from the filesystem so a branch rename shows up on the
   * button ("the name IS the feature"). Called by the render loop's periodic
   * sweep; only sessions whose BASE name changed are touched, so existing
   * duplicate suffixes never flap.
   */
  /** Name a session by hand (deck Rename key) — sticks through refreshes. */
  setLabelOverride(sessionId: string, name: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.labelOverride = name;
    entry.labelBase = name;
    entry.label = this.dedupeLabel(name, sessionId);
    this.emit("changed");
  }

  refreshLabels(): void {
    let changed = false;
    for (const entry of this.sessions.values()) {
      if (entry.labelOverride) continue; // hand-named — never re-derive
      const base = deriveLabel(entry.cwd);
      if (base === entry.labelBase) continue;
      entry.labelBase = base;
      entry.label = this.dedupeLabel(base, entry.sessionId);
      changed = true;
    }
    if (changed) this.emit("changed");
  }

  private consumePendingLaunch(entry: SessionEntry): void {
    const MAX_AGE_MS = 90_000;
    const now = Date.now();
    this.pendingLaunches = this.pendingLaunches.filter((l) => now - l.at < MAX_AGE_MS);
    const i = this.pendingLaunches.findIndex((l) => samePath(l.cwd, entry.cwd));
    if (i === -1) return;
    const launch = this.pendingLaunches.splice(i, 1)[0]!;
    entry.windowKind = "console";
    entry.pid = launch.pid;
    if (launch.hwnd) entry.hwnd = launch.hwnd;
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

  /** The session's window died: skull it, demote it to the END of the
   * overflow line (dead sessions never re-promote), and retarget if needed. */
  markWindowDead(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.windowDead) return;
    entry.windowDead = true;
    entry.deadAt = Date.now();
    this.emit("windowDead", entry); // listeners drop the persisted binding
    this.working = this.working.filter((s) => s !== sessionId);
    this.overflow = this.overflow.filter((s) => s !== sessionId);
    this.overflow.push(sessionId); // end of the line
    if (this.targeted === sessionId) this.targeted = this.working[0] ?? null;
    this.rebalance();
    this.emit("changed");
  }

  /** Dead sessions past their TTL are removed entirely. */
  sweepDead(ttlMs: number): void {
    const now = Date.now();
    for (const entry of [...this.sessions.values()]) {
      if (entry.windowDead && entry.deadAt && now - entry.deadAt > ttlMs) {
        this.release(entry.sessionId);
      }
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
    // Fill freed slots from the overflow front — but dead sessions stay at
    // the end of the line, never promoted back onto the deck.
    while (this.working.length < cap) {
      const next = this.overflow.findIndex((id) => !this.sessions.get(id)?.windowDead);
      if (next === -1) break;
      this.working.push(this.overflow.splice(next, 1)[0]!);
    }
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

/** Case/separator-insensitive Windows path equality. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
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
export function gitBranch(cwd: string): string | null {
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
