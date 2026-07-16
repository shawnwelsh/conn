import type { Slot } from "@claude-deck/shared";

/**
 * Turns raw key down/up events (from any client) into recognized gestures.
 * All timing logic lives here, bridge-side, so the web deck and the Elgato
 * plugin stay dumb.
 *
 * - long-press: still held longPressMs after down → fires WHILE held (so the
 *   deck can enter "move" mode and await the target press).
 * - double-tap: a second tap on the same slot within doubleTapMs.
 * - tap: a short press that isn't the first half of a double-tap.
 */
export type Gesture = "tap" | "double" | "long";

interface SlotState {
  downAt: number | null;
  longTimer: ReturnType<typeof setTimeout> | null;
  longFired: boolean;
  singleTimer: ReturnType<typeof setTimeout> | null;
  lastTapAt: number;
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
      s = { downAt: null, longTimer: null, longFired: false, singleTimer: null, lastTapAt: 0 };
      this.slots.set(slot, s);
    }
    return s;
  }

  down(slot: Slot): void {
    const s = this.state(slot);
    s.downAt = this.now();
    s.longFired = false;
    if (s.longTimer) clearTimeout(s.longTimer);
    s.longTimer = setTimeout(() => {
      s.longFired = true;
      s.longTimer = null;
      this.emit(slot, "long");
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
    // Short press → tap, with double-tap disambiguation.
    const at = this.now();
    s.downAt = null;
    if (s.singleTimer && at - s.lastTapAt <= this.cfg.doubleTapMs) {
      clearTimeout(s.singleTimer);
      s.singleTimer = null;
      s.lastTapAt = 0;
      this.emit(slot, "double");
      return;
    }
    s.lastTapAt = at;
    if (s.singleTimer) clearTimeout(s.singleTimer);
    s.singleTimer = setTimeout(() => {
      s.singleTimer = null;
      this.emit(slot, "tap");
    }, this.cfg.doubleTapMs);
  }
}
