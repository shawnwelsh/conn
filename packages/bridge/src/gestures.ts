import type { Slot } from "@belay/shared";

/**
 * Turns raw key down/up events (from any client) into recognized gestures.
 * All timing logic lives here, bridge-side, so the web deck and the Elgato
 * plugin stay dumb.
 *
 * - long-press: still held longPressMs after down → fires WHILE held (so the
 *   deck can enter "move" mode and await the target press).
 * - double-tap: a second tap on the same slot within doubleTapMs.
 * - double-long: a double-tap whose SECOND press is held (tap, then press-and-
 *   hold) → fires while held. "…and stay" modifier on the double-tap.
 * - tap: a short press that isn't the first half of a double-tap.
 */
export type Gesture = "tap" | "double" | "triple" | "long" | "doubleLong";

interface SlotState {
  downAt: number | null;
  longTimer: ReturnType<typeof setTimeout> | null;
  longFired: boolean;
  singleTimer: ReturnType<typeof setTimeout> | null;
  lastTapAt: number;
  /** Length of the current tap chain, for double/triple recognition. */
  tapCount: number;
}

export interface GestureConfig {
  doubleTapMs: number;
  longPressMs: number;
}

export class GestureRecognizer {
  private slots = new Map<Slot, SlotState>();

  constructor(
    private readonly cfg: GestureConfig,
    private readonly emit: (slot: Slot, gesture: Gesture) => void,
    /** Injectable clock so timers can be driven in tests. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  private state(slot: Slot): SlotState {
    let s = this.slots.get(slot);
    if (!s) {
      s = { downAt: null, longTimer: null, longFired: false, singleTimer: null, lastTapAt: 0, tapCount: 0 };
      this.slots.set(slot, s);
    }
    return s;
  }

  down(slot: Slot): void {
    const s = this.state(slot);
    const at = this.now();
    s.downAt = at;
    s.longFired = false;
    // Is this the second press of a double — i.e. one prior tap, still inside
    // the window? Then a hold means double-long, not a fresh long-press.
    const chained = s.tapCount === 1 && at - s.lastTapAt <= this.cfg.doubleTapMs;
    if (chained && s.singleTimer) {
      // Cancel the pending single-tap: this press upgrades it to a double(-long).
      clearTimeout(s.singleTimer);
      s.singleTimer = null;
    }
    if (s.longTimer) clearTimeout(s.longTimer);
    s.longTimer = setTimeout(() => {
      s.longFired = true;
      s.longTimer = null;
      if (chained) {
        s.tapCount = 0;
        s.lastTapAt = 0;
        this.emit(slot, "doubleLong");
      } else {
        this.emit(slot, "long");
      }
    }, this.cfg.longPressMs);
  }

  up(slot: Slot): void {
    const s = this.state(slot);
    if (s.longTimer) {
      clearTimeout(s.longTimer);
      s.longTimer = null;
    }
    if (s.longFired) {
      // The long-press already fired on hold; the release just ends it.
      s.longFired = false;
      s.downAt = null;
      return;
    }
    // Short press → tap / double / triple. Double still fires the instant the
    // second tap lands (focus must stay snappy); a third tap inside the window
    // then adds "triple" on top of it, so the rare gesture costs the common
    // one nothing.
    const at = this.now();
    s.downAt = null;
    const chain = s.tapCount > 0 && at - s.lastTapAt <= this.cfg.doubleTapMs ? s.tapCount + 1 : 1;
    s.tapCount = chain;
    s.lastTapAt = at;
    if (s.singleTimer) {
      clearTimeout(s.singleTimer);
      s.singleTimer = null;
    }
    if (chain === 1) {
      s.singleTimer = setTimeout(() => {
        s.singleTimer = null;
        s.tapCount = 0;
        this.emit(slot, "tap");
      }, this.cfg.doubleTapMs);
      return;
    }
    if (chain === 2) {
      this.emit(slot, "double");
      return;
    }
    s.tapCount = 0; // chain complete — a 4th tap starts fresh
    s.lastTapAt = 0;
    this.emit(slot, "triple");
  }
}
