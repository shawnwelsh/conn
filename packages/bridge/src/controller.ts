import type { Slot } from "@claude-deck/shared";
import type { SessionRegistry } from "./registry.js";
import type { DeckLayerState } from "./layers.js";
import { ROW2_IDLE_KEYS, QUESTION_OPTIONS_PER_PAGE } from "./layers.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { DeckConfig } from "./config.js";
import type { Logger } from "./log.js";
import { GestureRecognizer, type Gesture } from "./gestures.js";

/**
 * Routes recognized gestures (from any client) to actions. Clients report raw
 * key down/up only; the GestureRecognizer classifies tap/double/long here.
 */
export class DeckController {
  private readonly gestures: GestureRecognizer;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly layer: DeckLayerState,
    private readonly delivery: DeliveryAdapter,
    private readonly cfg: DeckConfig,
    private readonly log: Logger,
    private readonly onLayerChanged: () => void,
    /** Phase 2 wires this to the pending-decision store. */
    private hooks: {
      onPermissionKey?: (keyIndex: number) => void;
      onQuestionKey?: (optionIndex: number) => void;
      onQuestionPager?: () => void;
      /** Row-1 long-press → begin a move (wired in the paging increment). */
      onRow1LongPress?: (slot: Slot) => void;
    } = {},
  ) {
    this.gestures = new GestureRecognizer(
      { doubleTapMs: cfg.doubleTapMs, longPressMs: cfg.longPressMs },
      (slot, gesture) => this.dispatch(slot, gesture),
    );
  }

  setHooks(hooks: typeof this.hooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** Raw key events from clients — fed straight to the recognizer. */
  down(slot: Slot): void {
    this.gestures.down(slot);
  }
  up(slot: Slot): void {
    this.gestures.up(slot);
  }

  private dispatch(slot: Slot, gesture: Gesture): void {
    if (slot <= 4) {
      if (gesture === "long") {
        this.log.info({ slot }, "row1 long-press");
        return this.hooks.onRow1LongPress?.(slot);
      }
      if (gesture === "double") return void this.row1DoubleTap(slot);
      return this.row1Tap(slot);
    }
    // Rows 2 and 3 act on tap; double/long collapse to a tap for now.
    if (slot <= 9) return this.row2(slot - 5);
    return void this.row3(slot - 10);
  }

  private row1Tap(slot: Slot): void {
    const session = this.registry.targetSlot(slot);
    this.log.info({ slot, session: session?.sessionId }, "target");
  }

  private async row1DoubleTap(slot: Slot): Promise<void> {
    const session = this.registry.targetSlot(slot);
    if (!session) return;
    const ok = await this.delivery.focus(session);
    this.log.info({ slot, session: session.sessionId, ok }, "focus");
  }

  private row2(index: number): void {
    if (this.layer.row2 === "permission") {
      this.hooks.onPermissionKey?.(index);
      return;
    }
    if (this.layer.row2 === "question") {
      if (index === QUESTION_OPTIONS_PER_PAGE) {
        this.hooks.onQuestionPager?.();
      } else {
        this.hooks.onQuestionKey?.(index);
      }
      return;
    }
    // Idle layer commands → targeted session via delivery adapter.
    const target = this.registry.targetedSession;
    if (!target) return;
    const key = ROW2_IDLE_KEYS[index];
    if (!key) return;
    void (async () => {
      let ok = false;
      switch (key.label) {
        case "Plan": {
          // Blind plan⇄auto toggle: Ctrl+Shift+M then 4 (plan) / 3 (auto).
          // We can't read the visible tab's real mode, so just alternate.
          const next = this.layer.controls.planNext;
          ok = await this.delivery.sendSequence(target, ["ctrl+shift+m", next === "plan" ? "4" : "3"]);
          this.layer.controls.planNext = next === "plan" ? "auto" : "plan";
          this.onLayerChanged();
          break;
        }
        case "/compact":
        case "/review":
          ok =
            (await this.delivery.focus(target)) &&
            (await this.delivery.sendText(target, key.label)) &&
            (await this.delivery.sendKey(target, "enter"));
          break;
        case "New":
          ok = await this.delivery.sendKey(target, "ctrl+n");
          break;
        case "Esc":
          ok = await this.delivery.sendKey(target, "escape");
          break;
      }
      this.log.info({ key: key.label, session: target.sessionId, ok }, "row2 command");
    })();
  }

  private async row3(index: number): Promise<void> {
    const target = this.registry.targetedSession;
    switch (index) {
      case 0: // PTT — reserved (Phase 4)
        return;
      case 1:
        if (target) await this.delivery.sendKey(target, "enter");
        return;
      case 2: // Mode — open the full mode picker (Ctrl+Shift+M), pick on keyboard
        if (target) await this.delivery.sendKey(target, "ctrl+shift+m");
        return;
      case 3: {
        // Model cycle: Ctrl+Shift+I then 1-4, advancing each press.
        if (target) {
          const n = this.layer.controls.modelNext;
          await this.delivery.sendSequence(target, ["ctrl+shift+i", String(n)]);
          this.layer.controls.modelNext = (n % 4) + 1;
          this.onLayerChanged();
        }
        return;
      }
      case 4: // Page/profile switch — deck-local, Phase 3+
        return;
    }
  }
}
