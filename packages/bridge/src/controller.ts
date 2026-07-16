import type { Slot } from "@claude-deck/shared";
import type { SessionRegistry } from "./registry.js";
import type { DeckLayerState } from "./layers.js";
import { ROW2_IDLE_KEYS, QUESTION_OPTIONS_PER_PAGE } from "./layers.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { DeckConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Routes raw key presses (from any client) to actions. Owns single/double-tap
 * disambiguation — clients report raw presses only.
 */
export class DeckController {
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
    } = {},
  ) {}

  setHooks(hooks: typeof this.hooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  private pendingTap = new Map<Slot, ReturnType<typeof setTimeout>>();

  /** Raw press entry point. Row-1 keys get single/double disambiguation;
   * everything else acts immediately. */
  press(slot: Slot): void {
    if (slot <= 4) {
      const pending = this.pendingTap.get(slot);
      if (pending) {
        clearTimeout(pending);
        this.pendingTap.delete(slot);
        void this.row1DoubleTap(slot);
      } else {
        this.pendingTap.set(
          slot,
          setTimeout(() => {
            this.pendingTap.delete(slot);
            this.row1Tap(slot);
          }, this.cfg.doubleTapMs),
        );
      }
      return;
    }
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
        case "Plan":
          ok = await this.delivery.sendKey(target, "shift+tab");
          break;
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
      case 2:
        if (target) await this.delivery.sendKey(target, "shift+tab");
        return;
      case 3: {
        const canned = this.cfg.cannedCommands["key13"];
        if (target && canned) {
          (await this.delivery.focus(target)) &&
            (await this.delivery.sendText(target, canned.text)) &&
            (await this.delivery.sendKey(target, "enter"));
        }
        return;
      }
      case 4: // Page/profile switch — deck-local, Phase 3+
        return;
    }
  }
}
