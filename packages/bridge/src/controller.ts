import type { Slot } from "@claude-deck/shared";
import type { SessionRegistry, SessionEntry } from "./registry.js";
import type { DeckLayerState } from "./layers.js";
import { COMMANDS_PER_PAGE, QUESTION_OPTIONS_PER_PAGE } from "./layers.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { DeckConfig } from "./config.js";
import type { Logger } from "./log.js";
import { GestureRecognizer, type Gesture } from "./gestures.js";
import type { ConsoleLauncher } from "./delivery/launcher.js";
import { activeSuggestion } from "./suggestions.js";
import type { CommandSource, CommandEntry } from "./commands.js";

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
    } = {},
    /** Optional: the "New" key spawns console sessions through this. */
    private launcher?: ConsoleLauncher,
  ) {
    this.gestures = new GestureRecognizer(
      { doubleTapMs: cfg.doubleTapMs, longPressMs: cfg.longPressMs },
      (slot, gesture) => this.dispatch(slot, gesture),
    );
  }

  setHooks(hooks: typeof this.hooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  setLauncher(launcher: ConsoleLauncher): void {
    this.launcher = launcher;
  }

  private commands?: CommandSource;

  setCommands(store: CommandSource): void {
    this.commands = store;
  }

  /** Raw key events from clients — fed straight to the recognizer. */
  down(slot: Slot): void {
    this.gestures.down(slot);
  }
  up(slot: Slot): void {
    this.gestures.up(slot);
  }

  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  private dispatch(slot: Slot, gesture: Gesture): void {
    if (slot <= 4) return this.row1(slot, gesture);
    if (slot <= 9) return this.row2(slot - 5, gesture);
    // Row 3 acts on tap; double/long collapse to a tap.
    return void this.row3(slot - 10);
  }

  /** Row-1 gesture routing, dependent on the current row-1 mode. */
  private row1(slot: Slot, gesture: Gesture): void {
    const last = this.cfg.slots - 1; // last physical key = pager/control slot
    switch (this.layer.row1.mode) {
      case "move":
        if (gesture === "long") return; // ignore long-press while placing
        if (slot === last) return this.cancelMove();
        return this.completeMove(slot);
      case "pager":
        if (gesture === "long" && slot < last) return this.beginMoveFromPager(slot);
        if (slot === last) return this.pagerAdvanceOrClose();
        return this.pagerPick(slot);
      default: // agents
        if (this.registry.pagerActive() && slot === last) {
          if (gesture !== "long") this.openPager();
          return;
        }
        if (gesture === "long") return this.beginMove(this.registry.bySlot(slot)?.sessionId);
        if (gesture === "double") return void this.row1DoubleTap(slot);
        return this.row1Tap(slot);
    }
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

  // --- Pager (browse overflow → pick into slot #1) ---

  private openPager(): void {
    this.layer.row1 = { mode: "pager", pagerPage: 0 };
    this.registry.clearPagerFlash();
    this.onLayerChanged();
  }

  private closePager(): void {
    this.layer.row1 = { mode: "agents", pagerPage: 0 };
    this.onLayerChanged();
  }

  private pagerPick(slot: Slot): void {
    const perPage = this.cfg.slots - 1;
    const entry = this.registry.overflowEntries()[this.layer.row1.pagerPage * perPage + slot];
    if (entry) {
      this.registry.promoteToFront(entry.sessionId);
      this.log.info({ session: entry.sessionId }, "pager pick → slot 1");
    }
    this.closePager();
  }

  private pagerAdvanceOrClose(): void {
    const perPage = this.cfg.slots - 1;
    const pages = Math.max(1, Math.ceil(this.registry.overflowEntries().length / perPage));
    if (pages > 1) {
      this.layer.row1.pagerPage = (this.layer.row1.pagerPage + 1) % pages;
      this.onLayerChanged();
    } else {
      this.closePager();
    }
  }

  // --- Move (long-press a session, then tap its landing slot) ---

  private beginMove(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.layer.row1 = { mode: "move", pagerPage: 0, moveSource: sessionId };
    this.armMoveTimer();
    this.log.info({ session: sessionId }, "move: begin");
    this.onLayerChanged();
  }

  private beginMoveFromPager(slot: Slot): void {
    const perPage = this.cfg.slots - 1;
    const entry = this.registry.overflowEntries()[this.layer.row1.pagerPage * perPage + slot];
    this.beginMove(entry?.sessionId);
  }

  private completeMove(targetIndex: number): void {
    const src = this.layer.row1.moveSource;
    if (src) {
      this.registry.moveToSlot(src, targetIndex);
      this.log.info({ session: src, targetIndex }, "move: placed");
    }
    this.endMove();
  }

  private cancelMove(): void {
    this.log.info("move: cancelled");
    this.endMove();
  }

  private endMove(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.layer.row1 = { mode: "agents", pagerPage: 0 };
    this.onLayerChanged();
  }

  private armMoveTimer(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      if (this.layer.row1.mode === "move") this.cancelMove();
    }, this.cfg.moveCancelSeconds * 1000);
  }

  private row2(index: number, gesture: Gesture = "tap"): void {
    if (this.layer.row2 === "permission") {
      if (gesture === "tap" || gesture === "double") this.hooks.onPermissionKey?.(index);
      return;
    }
    // Suggestion layer (derived): Accept on key 6, banner keys focus the
    // session so you can read the context before deciding.
    const suggestion = activeSuggestion(this.registry, this.layer);
    if (suggestion) {
      void (async () => {
        if (index === 0) {
          const ok =
            (await this.delivery.focus(suggestion.session)) &&
            (await this.delivery.sendText(suggestion.session, this.cfg.suggestionAcceptText)) &&
            (await this.delivery.sendKey(suggestion.session, "enter"));
          if (ok) {
            suggestion.session.suggestion = undefined; // consumed
            this.onLayerChanged();
          }
          this.log.info({ session: suggestion.session.sessionId, ok }, "suggestion accepted");
        } else {
          await this.delivery.focus(suggestion.session);
        }
      })();
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
    // Command lineup (default / pager / move) — mirrors row 1's mechanics.
    const entries = this.commands?.all() ?? [];
    const last = COMMANDS_PER_PAGE; // key 10 = pager/control
    const cmd = this.layer.row2Cmd;
    switch (cmd.mode) {
      case "move": {
        if (gesture === "long") return;
        if (index === last) return this.endCmdMove(true);
        const src = cmd.moveSource;
        if (src !== undefined) {
          this.commands?.move(src, index);
          this.log.info({ from: src, to: index }, "cmd move: placed");
        }
        return this.endCmdMove(false);
      }
      case "pager": {
        const absolute = cmd.page * COMMANDS_PER_PAGE + index;
        if (gesture === "long" && index < last) return this.beginCmdMove(absolute);
        if (index === last) {
          // Cycle forward through all pages (wrap). The pager otherwise closes
          // on a command tap or the idle timeout — never leaving you stuck. If
          // the lineup shrank to a single page while open, the key closes.
          const pages = Math.max(1, Math.ceil(entries.length / COMMANDS_PER_PAGE));
          if (pages <= 1) return this.closeCmdPager();
          cmd.page = (cmd.page + 1) % pages;
          this.armCmdPagerTimer();
          this.onLayerChanged();
          return;
        }
        const entry = entries[absolute];
        this.closeCmdPager();
        if (entry) void this.executeCommand(entry);
        return;
      }
      default: {
        if (index === last) {
          if (gesture !== "long" && entries.length > COMMANDS_PER_PAGE) {
            // Open on page TWO — page one's commands are already on the
            // default row, so jump straight to the hidden ones.
            const pages = Math.ceil(entries.length / COMMANDS_PER_PAGE);
            this.layer.row2Cmd = { mode: "pager", page: pages > 1 ? 1 : 0 };
            this.armCmdPagerTimer();
            this.onLayerChanged();
          }
          return;
        }
        if (gesture === "long") {
          if (entries[index]) this.beginCmdMove(index);
          return;
        }
        const entry = entries[index];
        if (entry) void this.executeCommand(entry);
        else this.log.debug({ index }, "row2 tap on empty command slot");
        return;
      }
    }
  }

  /** Run one lineup entry against the targeted session, speaking its
   * dialect (console TUI vs desktop pickers). */
  private async executeCommand(entry: CommandEntry): Promise<void> {
    const target = this.registry.targetedSession;
    if (!target) {
      this.log.warn(
        { key: entry.kind === "builtin" ? entry.id : entry.label },
        "row2 command ignored: no targeted session",
      );
      return;
    }
    let ok = false;
    const name = entry.kind === "builtin" ? entry.id : entry.label;
    if (entry.kind === "builtin" && entry.id === "mode") {
      if (target.windowKind === "console") {
        ok = await this.delivery.sendKey(target, "shift+tab");
      } else {
        const next = this.layer.controls.planNext;
        ok = await this.delivery.sendSequence(target, ["ctrl+shift+m", next === "plan" ? "4" : "3"]);
        this.layer.controls.planNext = next === "plan" ? "auto" : "plan";
        this.onLayerChanged();
      }
    } else if (entry.kind === "builtin" && entry.id === "model") {
      ok = await this.cycleModel(target);
    } else if (entry.kind === "text") {
      ok =
        (await this.delivery.focus(target)) &&
        (await this.delivery.sendText(target, entry.text)) &&
        (await this.delivery.sendKey(target, "enter"));
    }
    this.log.info({ key: name, session: target.sessionId, kind: target.windowKind, ok }, "row2 command");
  }

  private async cycleModel(target: SessionEntry): Promise<boolean> {
    if (target.windowKind === "console") {
      return (
        (await this.delivery.focus(target)) &&
        (await this.delivery.sendText(target, "/model")) &&
        (await this.delivery.sendKey(target, "enter"))
      );
    }
    const n = this.layer.controls.modelNext;
    const ok = await this.delivery.sendSequence(target, ["ctrl+shift+i", String(n)]);
    this.layer.controls.modelNext = (n % 4) + 1;
    this.onLayerChanged();
    return ok;
  }

  private beginCmdMove(entryIndex: number): void {
    this.layer.row2Cmd = { mode: "move", page: 0, moveSource: entryIndex };
    this.armCmdMoveTimer();
    this.log.info({ entryIndex }, "cmd move: begin");
    this.onLayerChanged();
  }

  private endCmdMove(cancelled: boolean): void {
    if (this.cmdMoveTimer) clearTimeout(this.cmdMoveTimer);
    this.cmdMoveTimer = null;
    if (cancelled) this.log.info("cmd move: cancelled");
    this.layer.row2Cmd = { mode: "default", page: 0 };
    this.onLayerChanged();
  }

  private closeCmdPager(): void {
    if (this.cmdPagerTimer) clearTimeout(this.cmdPagerTimer);
    this.cmdPagerTimer = null;
    this.layer.row2Cmd = { mode: "default", page: 0 };
    this.onLayerChanged();
  }

  private cmdMoveTimer: ReturnType<typeof setTimeout> | null = null;

  private armCmdMoveTimer(): void {
    if (this.cmdMoveTimer) clearTimeout(this.cmdMoveTimer);
    this.cmdMoveTimer = setTimeout(() => {
      if (this.layer.row2Cmd.mode === "move") this.endCmdMove(true);
    }, this.cfg.moveCancelSeconds * 1000);
  }

  private cmdPagerTimer: ReturnType<typeof setTimeout> | null = null;

  /** Idle-revert the command pager to the default view when the Page key
   * hasn't been pressed for a while — re-armed on every page advance. */
  private armCmdPagerTimer(): void {
    if (this.cmdPagerTimer) clearTimeout(this.cmdPagerTimer);
    this.cmdPagerTimer = setTimeout(() => {
      if (this.layer.row2Cmd.mode === "pager") this.closeCmdPager();
    }, this.cfg.cmdPagerRevertSeconds * 1000);
  }

  /** Row 3: PTT / interrupt / globals; the Page key flips global pages. */
  private async row3(index: number): Promise<void> {
    const target = this.registry.targetedSession;
    if (index === 4) {
      // Page — toggle between the two global pages.
      this.layer.row3Page = this.layer.row3Page === 0 ? 1 : 0;
      this.onLayerChanged();
      return;
    }
    if (this.layer.row3Page === 1) {
      if (index === 0 && target) {
        // Mode (menu): open the full Ctrl+Shift+M picker on screen.
        const ok = await this.delivery.sendKey(target, "ctrl+shift+m");
        this.log.info({ key: "ModeMenu", session: target.sessionId, ok }, "row3 command");
      }
      return; // remaining page-2 slots reserved for future globals
    }
    switch (index) {
      case 0: // PTT — reserved (Phase 4)
        return;
      case 1:
        if (target) await this.delivery.sendKey(target, "enter");
        return;
      case 2: // Esc — interrupt the targeted session
        if (target) await this.delivery.sendKey(target, "escape");
        return;
      case 3: {
        // New — fresh worktree + console session. A GLOBAL key: works with
        // no session targeted (targeted repo → configured default repo).
        const dir = target?.cwd ?? this.cfg.newSessionDir;
        if (!dir) {
          this.log.warn("New ignored: no targeted session and no newSessionDir configured");
          return;
        }
        if (this.layer.launching) {
          this.log.info("New ignored: launch already in flight");
          return;
        }
        this.layer.launching = true;
        this.onLayerChanged();
        try {
          const ok = (await this.launcher?.launch(dir)) ?? false;
          this.log.info({ key: "New", cwd: dir, ok }, "row3 command");
        } finally {
          this.layer.launching = false;
          this.onLayerChanged();
        }
        return;
      }
    }
  }
}
