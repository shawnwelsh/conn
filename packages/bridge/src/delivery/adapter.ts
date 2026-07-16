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
}

export interface DeliveryAdapter {
  /** Bring the session's window to the foreground. */
  focus(session: SessionRef): Promise<boolean>;
  /** Type literal text into the session (does not press Enter). */
  sendText(session: SessionRef, text: string): Promise<boolean>;
  /** Press a key chord, e.g. "enter", "escape", "shift+tab", "2". */
  sendKey(session: SessionRef, chord: string): Promise<boolean>;
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
  async dispose(): Promise<void> {}
}
