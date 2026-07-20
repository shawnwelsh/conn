import type { DecisionStore } from "./decisions.js";
import type { DeckLayerState } from "./layers.js";
import type { SttEngine } from "./stt/sidecar.js";
import type { Logger } from "./log.js";

/**
 * Deny-with-dictated-reason (Phase 4, per docs/DESIGN-phase4-ptt.md):
 * on the permission layer, "Deny + reason" starts a bounded recording
 * window against the CURRENT held decision; a second press (or the window
 * elapsing) stops it, and the transcription is inserted into the still-held
 * hook response as {behavior:"deny", message}. No keystroke delivery — the
 * reason reaches Claude as structured feedback.
 *
 * Posture:
 *  - Sidecar not ready → plain canned deny immediately (never queue audio).
 *  - The overall decision timeout keeps running; if it expires (or the
 *    decision settles any other way) mid-recording, recording cancels and
 *    the request follows its normal path — recording never extends a hold.
 *  - Empty/failed transcription → the canned deny message.
 */
export class DenyReasonFlow {
  private active: { decisionId: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly decisions: DecisionStore,
    private readonly stt: SttEngine | undefined,
    private readonly layer: DeckLayerState,
    private readonly maxSeconds: number,
    private readonly log: Logger,
    private readonly onChange: () => void,
  ) {}

  get recording(): boolean {
    return this.active !== null;
  }

  /** The "Deny + reason" key: first press arms the mic, second press stops
   * early. Falls back to a plain canned deny when dictation can't happen. */
  press(): void {
    if (this.active) {
      void this.finish("stopped early");
      return;
    }
    const pending = this.decisions.current;
    if (!pending) return;
    if (!this.stt || this.stt.status !== "ready") {
      this.log.info({ stt: this.stt?.status ?? "absent" }, "deny-reason: sidecar not ready — canned deny");
      this.decisions.decide("deny-reason");
      return;
    }
    const decisionId = pending.id;
    void this.stt.start().then((ok) => {
      if (!ok) {
        // Mic didn't open — behave exactly like the stub did.
        if (this.decisions.current?.id === decisionId) this.decisions.decide("deny-reason");
        return;
      }
      if (this.decisions.current?.id !== decisionId) {
        void this.stt!.cancel(); // settled while the mic spun up
        return;
      }
      this.active = {
        decisionId,
        timer: setTimeout(() => void this.finish("window elapsed"), this.maxSeconds * 1000),
      };
      this.layer.permissionRec = { deadline: Date.now() + this.maxSeconds * 1000 };
      this.log.info({ decisionId, maxSeconds: this.maxSeconds }, "deny-reason: recording");
      this.onChange();
    });
  }

  /** Decision-store change hook: if OUR decision is no longer current (other
   * key, on-screen answer, timeout, session end), the recording is moot. */
  sync(): void {
    if (this.active && this.decisions.current?.id !== this.active.decisionId) {
      const { timer } = this.active;
      clearTimeout(timer);
      this.active = null;
      this.layer.permissionRec = undefined;
      void this.stt?.cancel();
      this.log.info("deny-reason: decision settled elsewhere — recording cancelled");
      this.onChange();
    }
  }

  private async finish(why: string): Promise<void> {
    if (!this.active || !this.stt) return;
    const { decisionId, timer } = this.active;
    clearTimeout(timer);
    this.active = null;
    this.layer.permissionRec = undefined;
    this.onChange(); // the key face flips to "transcribing" via layer.ptt
    const text = (await this.stt.stop()).trim();
    if (this.decisions.current?.id !== decisionId) {
      this.log.info({ why }, "deny-reason: decision already settled — transcription discarded");
      return;
    }
    this.decisions.decide("deny-reason", text ? { message: text } : undefined);
    this.log.info({ why, chars: text.length }, "deny-reason: denied with dictated reason");
  }
}
