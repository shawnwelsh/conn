import { EventEmitter } from "node:events";
import { basename, join, resolve, isAbsolute, dirname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { SessionStatus } from "@conn/shared";
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
  /** Name Claude Code itself carries for the conversation (`/rename`), read
   * from its session metadata. Beats the branch, loses to a deck rename. */
  ccName?: string;
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
  /** The option reader is reading this turn's ending right now — the keys say
   * so, because a row that silently rearranges ~13s later invites a mispress. */
  optionsPending?: boolean;
  /** Choices the option reader found in the prose, or its verdict that they
   * don't fit on keys. Cleared with `suggestion`. */
  suggestionOptions?: { question: string; options: string[]; viewInWindow?: boolean };
  /** The bound window died (no clean SessionEnd) — rendered with a skull,
   * demoted to the end of the overflow line, swept after a TTL. */
  windowDead?: boolean;
  deadAt?: number;
  /** Swept off the deck by the Tidy key, but still tracked. Kept in the sessions
   * map (so the 30s re-scan sees it as "known" and doesn't drag it back) but
   * pulled out of working/overflow so it renders nowhere. Cleared by wake()
   * the moment the human types into it (UserPromptSubmit). */
  hidden?: boolean;
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
 * Owns the deck's session model as ONE ordered list, split for storage:
 *  - `working`: page 1, in slot order. Stable — targeting or using a session
 *    never reorders them.
 *  - `overflow`: pages 2+, most-recently-used first. Capped at `maxTracked`
 *    total sessions (LRU-evicted beyond that).
 *
 * When >slotCount sessions are tracked the last key becomes the Page key and
 * each page holds slotCount-1 sessions. Nothing auto-promotes: a session that
 * needs attention stays where it is and says so on the Page key, because a
 * deck that rearranges itself under your thumb can't be used by muscle memory.
 */
export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  private working: string[] = [];
  private overflow: string[] = []; // MRU: index 0 = most recent
  private targeted: string | null = null;
  private pendingLaunches: PendingLaunch[] = [];
  /** Persisted display order, by cwd (the only identity stable across
   * restarts — sessionIds are per-run). A rediscovered session slots back to
   * its saved rank; unknowns append. Populated by loadOrder(), refreshed on
   * every manual move. */
  private savedRank = new Map<string, number>();

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

  /** True when the Page key occupies the last slot (more sessions than slots).
   * Counts the VISIBLE list (working + overflow), not the sessions map — swept
   * (hidden) sessions are out of both, so they must not force the pager on. */
  pagerActive(): boolean {
    return this.working.length + this.overflow.length > this.slotCount;
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

  /**
   * Every session in display order — row 1 pages through this. `working` is
   * simply page 1; overflow is pages 2+. Nothing here reorders on use, so a
   * page you're looking at stays put under your thumb.
   */
  orderedEntries(): SessionEntry[] {
    return [...this.working, ...this.overflow].map((id) => this.sessions.get(id)!).filter(Boolean);
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
      // Listeners bind terminals immediately, rather than leaving a fresh
      // session mis-classified until the next 30s sweep — commands aimed at
      // a "desktop" session go to the app's front window, which would be the
      // wrong place entirely.
      this.emit("session-added", entry);
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

  /** Swap a covering provisional (launching:*) key's identity to a real session
   * id, keeping its slot/order and window binding. The single place a
   * placeholder becomes a real session — shared by the hook path
   * (adoptProvisional) and the interactive-adopt path (adoptProvisionalTerminal).
   * Returns the entry, or null if no provisional covers `cwd`. */
  private reconcileProvisional(cwd: string, newSessionId: string): SessionEntry | null {
    for (const entry of this.sessions.values()) {
      if (!entry.sessionId.startsWith("launching:")) continue;
      // The session may have moved into a subdirectory of where it launched.
      if (!pathWithin(cwd, entry.cwd)) continue;
      const oldId = entry.sessionId;
      this.sessions.delete(oldId);
      entry.sessionId = newSessionId;
      this.sessions.set(newSessionId, entry);
      this.working = this.working.map((id) => (id === oldId ? newSessionId : id));
      this.overflow = this.overflow.map((id) => (id === oldId ? newSessionId : id));
      if (this.targeted === oldId) this.targeted = newSessionId;
      // The matching pending launch is now consumed too.
      this.pendingLaunches = this.pendingLaunches.filter((l) => !samePath(l.cwd, entry.cwd));
      this.emit("changed");
      return entry;
    }
    return null;
  }

  /** Hook path: a real session's first event arrived — adopt its provisional. */
  private adoptProvisional(event: AnyHookEvent): SessionEntry | null {
    return this.reconcileProvisional(event.cwd ?? "", event.session_id);
  }

  /**
   * Interactive-adopt path: reconcile a covering provisional into a terminal
   * session Claude Code knows about but that fired no SessionStart hook.
   *
   * Without this, a restored provisional (from a persisted console binding)
   * sits as a `launching:*` phantom while the real session can't surface —
   * adoptTerminals sees the tree already "covered" and skips it — so the key
   * keeps its codename, `/rename` can't attach (no real sessionId), and on the
   * next launch the real session lands as a "name 2" duplicate. This is the
   * root of the stranded-key / detached-session / duplicate mess. Binds the pid
   * and carries Claude Code's name/status across.
   */
  adoptProvisionalTerminal(meta: {
    sessionId: string;
    cwd?: string;
    pid: number;
    name?: string;
    status?: SessionStatus;
  }): SessionEntry | null {
    const entry = this.reconcileProvisional(meta.cwd ?? "", meta.sessionId);
    if (!entry) return null;
    if (!entry.pid) entry.pid = meta.pid;
    entry.windowKind = "console";
    if (meta.status) entry.status = meta.status;
    if (meta.name) {
      entry.ccName = meta.name;
      entry.labelBase = meta.name;
      entry.label = this.dedupeLabel(meta.name, meta.sessionId);
    }
    this.emit("changed");
    return entry;
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
  /**
   * Bind a session to its terminal process, learned from Claude Code's own
   * metadata. This is how sessions the deck DIDN'T launch become
   * controllable: delivery injects by pid, so a process id is the whole
   * requirement.
   *
   * Never touches an already-bound session — a deck-launched console holds
   * the cmd pid plus a window handle for focus, which is strictly better.
   */
  adoptTerminal(sessionId: string, pid: number): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.pid) return false;
    entry.pid = pid;
    entry.windowKind = "console";
    this.emit("changed");
    return true;
  }

  /**
   * Surface a terminal session Claude Code knows about but the deck has never
   * heard from.
   *
   * Interactive sessions fire no SessionStart — a session's first hook is its
   * first prompt or tool call — so one sitting idle is invisible to the deck
   * no matter how long it's been open. Claude Code's metadata is the only
   * evidence it exists, and a pid is all delivery needs.
   *
   * Returns the entry, or null if it was already known (hooks win: a session
   * we've heard from has richer, live state than a file on disk).
   */
  addKnownTerminal(meta: {
    sessionId: string;
    pid: number;
    cwd?: string;
    name?: string;
    status?: SessionStatus;
  }): SessionEntry | null {
    if (this.sessions.has(meta.sessionId)) return null;
    const cwd = meta.cwd ?? "";
    const base = meta.name ?? deriveLabel(cwd);
    const entry: SessionEntry = {
      sessionId: meta.sessionId,
      slot: -1,
      label: this.dedupeLabel(base, meta.sessionId),
      labelBase: base,
      ccName: meta.name,
      cwd,
      status: meta.status ?? "idle",
      lastEventAt: Date.now(),
      windowKind: "console",
      pid: meta.pid,
      events: new RingBuffer(this.eventHistorySize),
    };
    this.sessions.set(entry.sessionId, entry);
    this.place(entry.sessionId);
    if (!this.targeted) this.targeted = entry.sessionId;
    this.emit("changed");
    return entry;
  }

  /** Name a session by hand (deck Rename key) — sticks through refreshes. */
  setLabelOverride(sessionId: string, name: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.labelOverride = name;
    entry.labelBase = name;
    entry.label = this.dedupeLabel(name, sessionId);
    this.emit("changed");
  }

  /**
   * Re-derive labels, newest name wins by precedence:
   *   deck rename (labelOverride) → Claude Code `/rename` → git branch → cwd.
   * `ccNames` comes from Claude Code's own session metadata; omit it to just
   * re-check branches.
   */
  refreshLabels(ccNames?: Map<string, string>): void {
    let changed = false;
    for (const entry of this.sessions.values()) {
      if (ccNames) {
        const named = ccNames.get(entry.sessionId);
        if (named !== undefined) entry.ccName = named;
      }
      if (entry.labelOverride) continue; // hand-named on the deck — final say
      const base = entry.ccName ?? deriveLabel(entry.cwd);
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
    const i = this.pendingLaunches.findIndex((l) => pathWithin(entry.cwd, l.cwd));
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
    // Deliberately does NOT reshuffle the deck. A session that needs you used
    // to be yanked onto the visible page, which fights "press to use, stay on
    // that page" — the page you were reading would rearrange under your
    // thumb. Off-page attention is announced on the Page key instead.
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

  /**
   * Insert-before against the FULL ordered list, so a move can cross a page
   * boundary — you can drag a session from page 2 onto page 1 and it stays
   * where you put it.
   */
  moveToIndex(sessionId: string, targetIndex: number): void {
    if (!this.sessions.has(sessionId)) return;
    const order = [...this.working, ...this.overflow].filter((s) => s !== sessionId);
    const idx = Math.max(0, Math.min(targetIndex, order.length));
    order.splice(idx, 0, sessionId);
    const cap = this.capacity();
    this.working = order.slice(0, cap);
    this.overflow = order.slice(cap);
    this.syncSlots();
    this.rememberOrder(); // this arrangement is now the one to restore
    this.emit("changed");
    this.emit("reordered"); // index.ts persists it
  }

  /** Restore a saved display order (list of cwds, front-first). Applied before
   * sessions are adopted, so each slots back to its remembered rank. */
  loadOrder(cwds: string[]): void {
    this.savedRank = new Map(cwds.map((cwd, i) => [cwd, i]));
  }

  /** The current display order as cwds (deduped, front-first) — what gets
   * persisted after a move. */
  orderedCwds(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...this.working, ...this.overflow]) {
      const cwd = this.sessions.get(id)?.cwd;
      if (cwd !== undefined && !seen.has(cwd)) {
        seen.add(cwd);
        out.push(cwd);
      }
    }
    return out;
  }

  private rememberOrder(): void {
    this.loadOrder(this.orderedCwds());
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

  /**
   * Tidy: hide a cohort of sessions by window kind. NOTHING is ended — the
   * sessions keep running; this only takes their keys off the deck. They leave
   * working AND overflow but stay tracked in the sessions map — that's what
   * makes the 30s re-scan treat them as "known" and NOT drag them back. They
   * return through the normal path, at the end of the row, the moment the human
   * types into one (wake(), on UserPromptSubmit).
   *
   * Launches in flight (`launching:*`) are never swept — a console you just
   * asked for shouldn't vanish before it's even bound. Returns the count hidden.
   */
  sweep(kinds: Array<"console" | "desktop">): number {
    let n = 0;
    for (const entry of this.sessions.values()) {
      if (entry.hidden || entry.sessionId.startsWith("launching:")) continue;
      if (!kinds.includes(entry.windowKind)) continue;
      entry.hidden = true;
      n++;
    }
    if (n === 0) return 0;
    this.working = this.working.filter((id) => !this.sessions.get(id)?.hidden);
    this.overflow = this.overflow.filter((id) => !this.sessions.get(id)?.hidden);
    // Retarget only if the target itself was swept — leave a surviving target be.
    if (this.targeted && this.sessions.get(this.targeted)?.hidden) this.targeted = null;
    this.rebalance();
    if (!this.targeted) this.targeted = this.working[0] ?? this.overflow[0] ?? null;
    this.emit("changed");
    return n;
  }

  /**
   * Un-hide a swept session and return it to the END of the row — no position
   * memory, exactly as a freshly-discovered session would arrive. Pushed to the
   * back of the line; rebalance pulls it up into a working slot only if one is
   * free. A no-op unless the session is actually hidden, so it's cheap to call
   * on every UserPromptSubmit.
   */
  wake(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.hidden) return;
    entry.hidden = false;
    this.overflow.push(sessionId); // end of the line
    this.rebalance();
    this.emit("changed");
  }

  snapshot(): RegistrySnapshot {
    return {
      sessions: this.all().map((s) => ({ ...s, events: s.events.toArray() })),
      targetedSessionId: this.targeted,
      working: [...this.working],
      overflow: [...this.overflow],
      pagerActive: this.pagerActive(),
      pagerFlash: false, // retired: attention is announced on the Page key
    };
  }

  /** Place a newly-tracked session. If its cwd has a remembered rank (restored
   * order), slot it there so a restart rebuilds the arrangement as sessions are
   * rediscovered; otherwise append, as before. */
  private place(sessionId: string): void {
    const cwd = this.sessions.get(sessionId)?.cwd;
    const rank = cwd !== undefined ? this.savedRank.get(cwd) : undefined;
    if (rank === undefined) {
      if (this.working.length < this.capacity()) this.working.push(sessionId);
      else this.overflow.unshift(sessionId);
      this.rebalance();
      return;
    }
    // Insert into the combined order just before the first session that ranks
    // AFTER this one (unknowns count as after everything).
    const combined = [...this.working, ...this.overflow];
    const rankOf = (id: string): number => {
      const c = this.sessions.get(id)?.cwd;
      return (c !== undefined ? this.savedRank.get(c) : undefined) ?? Number.POSITIVE_INFINITY;
    };
    let at = combined.length;
    for (let i = 0; i < combined.length; i++) {
      if (rankOf(combined[i]!) > rank) {
        at = i;
        break;
      }
    }
    combined.splice(at, 0, sessionId);
    const cap = this.capacity();
    this.working = combined.slice(0, cap);
    this.overflow = combined.slice(cap);
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
 * Is `child` the same directory as `root`, or inside it?
 *
 * Sessions report the cwd they're CURRENTLY in, which drifts below the
 * directory we launched them in (a session working in
 * `<worktree>\scratch\foo` still belongs to `<worktree>`). Matching a launch
 * on equality alone let that session register as a brand-new desktop entry
 * beside its own console key — the phantom duplicate with a " 2" suffix.
 */
export function pathWithin(child: string, root: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r + "\\");
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
