/**
 * The swappable input-delivery boundary. Business logic (layers, controller)
 * only ever talks to this interface; the Windows-desktop implementation (AHK
 * daemon), the degraded SendKeys fallback, and the future tmux adapter
 * (`tmux send-keys -t <pane>`) are drop-in replacements behind it.
 *
 * Permission decisions never pass through here — they return via the
 * PermissionRequest hook's HTTP response.
 */

export interface SessionRef {
  sessionId: string;
  cwd: string;
  label: string;
  /** OS window handle when this session has its own window (deck-launched
   * console). Used for focus/surfacing; delivery prefers `pid`. */
  hwnd?: number;
  /** Console process id (deck-launched). When present, text/keys inject
   * straight into the console INPUT BUFFER (AttachConsole+WriteConsoleInput)
   * — focus-free and host-agnostic (Windows Terminal or classic conhost). */
  pid?: number;
  /** Name Claude Code carries for the conversation (`/rename`). Claude Code
   * retitles the terminal to this, so it's the title a moved Windows Terminal
   * tab still shows — the key to re-finding a console window that lost the
   * handle we captured at launch (before any rename it's the codename, i.e.
   * the cwd leaf). */
  ccName?: string;
}

export interface DeliveryAdapter {
  /** Bring the session's window to the foreground. */
  focus(session: SessionRef): Promise<boolean>;
  /** Maximise (full-screen) or restore the session's window. Optional — the
   * degraded adapters can't, and the caller no-ops gracefully. */
  setWindowState?(session: SessionRef, state: "maximize" | "restore"): Promise<boolean>;
  /** Type literal text into the session (does not press Enter). */
  sendText(session: SessionRef, text: string): Promise<boolean>;
  /** Press a key chord, e.g. "enter", "escape", "shift+tab", "2". */
  sendKey(session: SessionRef, chord: string): Promise<boolean>;
  /** Press a series of chords with a short gap between each — for
   * menu-then-number pickers, e.g. ["ctrl+shift+m", "4"]. */
  sendSequence(session: SessionRef, chords: string[]): Promise<boolean>;
  /** Resolve a process id to its top-level window handle, or null. Used by
   * the console launcher to bind spawned terminals to sessions. */
  findWindowByPid(pid: number): Promise<number | null>;
  /** Visible window whose title contains the string, or null. Used once at
   * spawn to grab a Windows Terminal window by its launch title token. */
  findWindowByTitle?(title: string): Promise<number | null>;
  /** Is this bound window still alive? `null` = adapter can't tell (never
   * treated as dead). Drives the dead-session skull. */
  checkWindow(hwnd: number): Promise<boolean | null>;
  /** Is this process still alive? `null` = can't tell. The truer liveness
   * signal for WT-hosted consoles (their window belongs to WT, not them). */
  checkPid?(pid: number): Promise<boolean | null>;
  dispose(): Promise<void>;
}

/** Phase-1 stand-in: logs the intent and reports failure so callers can
 * surface "delivery unavailable" honestly. Replaced in Phase 3. */
export class NoopAdapter implements DeliveryAdapter {
  constructor(private readonly onCall: (method: string, detail: string) => void) {}
  async focus(s: SessionRef): Promise<boolean> {
    this.onCall("focus", s.label);
    return false;
  }
  async sendText(s: SessionRef, text: string): Promise<boolean> {
    this.onCall("sendText", `${s.label}: ${text}`);
    return false;
  }
  async sendKey(s: SessionRef, chord: string): Promise<boolean> {
    this.onCall("sendKey", `${s.label}: ${chord}`);
    return false;
  }
  async sendSequence(s: SessionRef, chords: string[]): Promise<boolean> {
    this.onCall("sendSequence", `${s.label}: ${chords.join(" , ")}`);
    return false;
  }
  async findWindowByPid(pid: number): Promise<number | null> {
    this.onCall("findWindowByPid", String(pid));
    return null;
  }
  async findWindowByTitle(title: string): Promise<number | null> {
    this.onCall("findWindowByTitle", title);
    return null;
  }
  async checkWindow(_hwnd: number): Promise<boolean | null> {
    return null; // can't tell — never marks sessions dead
  }
  async checkPid(_pid: number): Promise<boolean | null> {
    return null; // can't tell — never marks sessions dead
  }
  async dispose(): Promise<void> {}
}
