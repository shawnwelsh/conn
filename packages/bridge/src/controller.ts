import type { Slot } from "@belay/shared";
import { gitBranch, type SessionRegistry, type SessionEntry } from "./registry.js";
import { slugifyName, isDeckBranch, renameDeckBranch } from "./rename.js";
import type { DeckLayerState } from "./layers.js";
import { COMMANDS_PER_PAGE, QUESTION_OPTIONS_PER_PAGE, HAS_GLOBALS_PAGE2, row1Pagination } from "./layers.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { DeckConfig } from "./config.js";
import type { Logger } from "./log.js";
import { GestureRecognizer, type Gesture } from "./gestures.js";
import type { ConsoleLauncher } from "./delivery/launcher.js";
import { activeSuggestion, isChoiceQuestion } from "./suggestions.js";
import { isAwaitingInput, CC_SESSIONS_DIR } from "./sessionMeta.js";
import type { CommandSource, CommandEntry } from "./commands.js";
import type { SttEngine } from "./stt/sidecar.js";

/** Physical key hosting the mic (row 3 key 1). */
const PTT_SLOT = 10;

/** Gap between typed text and its submitting Enter on console sessions. */
const CONSOLE_SUBMIT_GAP_MS = 150;

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

  private stt?: SttEngine;

  setStt(stt: SttEngine): void {
    this.stt = stt;
  }

  /**
   * "Is this session sitting at a prompt?" — Claude Code's own published
   * status, read fresh from disk. Injectable so tests don't depend on
   * ~/.claude/sessions. Returns null when it can't tell.
   */
  private promptProbe: (sessionId: string) => boolean | null = (id) =>
    isAwaitingInput(id, CC_SESSIONS_DIR, this.log);

  setPromptProbe(probe: (sessionId: string) => boolean | null): void {
    this.promptProbe = probe;
  }

  /** Poll briefly for a prompt to appear (a confirm renders asynchronously).
   * False when none shows up, or when we simply can't tell. */
  private async waitForPrompt(sessionId: string, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (this.promptProbe(sessionId) === true) return true;
    }
    return false;
  }

  /** Notified when a session gets a hand-typed name, so console bindings can
   * persist it across bridge restarts. */
  private onSessionRenamed?: (session: SessionEntry) => void;

  setOnSessionRenamed(fn: (session: SessionEntry) => void): void {
    this.onSessionRenamed = fn;
  }

  /** Raw key events from clients — fed straight to the recognizer, except
   * the mic key: it acts on the DOWN edge (snappier than tap classification)
   * while on the globals' default page — and it OWNS the key while a
   * dictation is live, even if the globals page flipped mid-recording. */
  down(slot: Slot): void {
    if (slot === PTT_SLOT && this.stt && (this.layer.row3Page === 0 || this.pttActive)) {
      this.pttPressed = true;
      void this.pttToggle();
      return;
    }
    this.gestures.down(slot);
  }
  up(slot: Slot): void {
    if (this.pttPressed && slot === PTT_SLOT) {
      this.pttPressed = false; // swallow the matching release
      return;
    }
    this.gestures.up(slot);
  }

  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  private dispatch(slot: Slot, gesture: Gesture): void {
    if (slot <= 4) return this.row1(slot, gesture);
    if (slot <= 9) return this.row2(slot - 5, gesture);
    // Row 3 acts on tap; double/long collapse to a tap.
    return void this.row3(slot - 10);
  }

  /** Row 1's current page: which sessions sit on which keys right now. */
  private row1Layout() {
    const ordered = this.registry.orderedEntries();
    return { ordered, ...row1Pagination(ordered.length, this.cfg.slots, this.layer.row1.page) };
  }

  /** The session under a row-1 key on the CURRENT page. */
  private row1Entry(slot: Slot): SessionEntry | undefined {
    const { ordered, size, page } = this.row1Layout();
    return slot < size ? ordered[page * size + slot] : undefined;
  }

  /** Row-1 gesture routing, dependent on the current row-1 mode. */
  private row1(slot: Slot, gesture: Gesture): void {
    const { paged, size } = this.row1Layout();
    if (this.layer.row1.mode === "move") {
      const last = this.cfg.slots - 1;
      if (slot === last) {
        // With more positions than fit, this key has to page — otherwise a
        // move can only ever shuffle within the page you grabbed from, which
        // is useless for the thing you actually want (carry it to the front).
        // Cancel moves onto the hold, and the auto-cancel timer is the net.
        if (this.movePages() > 1 && gesture !== "long") return this.pageMoveTargets();
        return this.cancelMove();
      }
      if (gesture === "long") return; // ignore long-press on a drop target
      return this.completeMove(slot);
    }
    // agents
    // While a morph is up, keys 2-5 are one wide banner spelling out what is
    // being decided — NOT sessions. Sending them through slot logic would
    // retarget, or long-press-move, whoever happens to sit there. A tap brings
    // the asking session forward instead: the deck can only show so much, and
    // "let me go read it" is the honest next move.
    if (this.morphSessionId() && slot > 0) {
      if (gesture === "tap" || gesture === "double") void this.focusMorphSession();
      return;
    }
    // Paging happens in place: the row keeps showing sessions, so a press
    // still uses one and leaves you exactly where you were reading.
    if (paged && slot === size) {
      if (gesture !== "long") this.pageRow1();
      return;
    }
    const entry = this.row1Entry(slot);
    // A rename is listening on this very key (it counts down there) — any
    // press stops it, which is where the hand already is.
    if (this.layer.renameRec && this.layer.renameRec.sessionId === entry?.sessionId) {
      return void this.renameFinish();
    }
    if (gesture === "long") return this.beginMove(entry?.sessionId);
    if (gesture === "triple") return void this.row1TripleTap(entry);
    if (gesture === "double") return void this.row1DoubleTap(entry);
    return this.row1Tap(entry);
  }

  private pageRow1(): void {
    const { pages } = this.row1Layout();
    this.layer.row1.page = (this.layer.row1.page + 1) % pages;
    this.log.info({ page: this.layer.row1.page }, "row1: page");
    this.onLayerChanged();
  }

  /** The session behind the active morph layer, if any. */
  private morphSessionId(): string | undefined {
    if (this.layer.row2 === "permission") return this.layer.permission?.sessionId;
    if (this.layer.row2 === "question") return this.layer.question?.sessionId;
    return undefined;
  }

  private async focusMorphSession(): Promise<void> {
    const id = this.morphSessionId();
    const session = id ? this.registry.get(id) : undefined;
    if (!session) return;
    const ok = await this.delivery.focus(session);
    this.log.info({ session: session.sessionId, ok }, "banner tap → focus asking session");
  }

  /** Tap = target, and NOTHING moves. The session stays on the key you pressed
   * so the next press lands where your hand already is. */
  private row1Tap(session: SessionEntry | undefined): void {
    if (!session) return;
    this.registry.target(session.sessionId);
    this.log.info({ session: session.sessionId }, "target");
  }

  private async row1DoubleTap(session: SessionEntry | undefined): Promise<void> {
    if (!session) return;
    this.registry.target(session.sessionId);
    const ok = await this.delivery.focus(session);
    this.log.info({ session: session.sessionId, ok }, "focus");
  }

  /** Triple-tap a session key = the final say on its name. Rare gesture for a
   * rare act; the double-tap focus it rides in on is a harmless side effect. */
  private async row1TripleTap(session: SessionEntry | undefined): Promise<void> {
    if (!session) return;
    this.registry.target(session.sessionId);
    this.log.info({ session: session.sessionId }, "rename: triple-tap");
    await this.renameToggle(session);
  }

  // --- Move (long-press a session, then tap its landing slot) ---

  private beginMove(sessionId: string | undefined): void {
    if (!sessionId) return;
    // Drop targets always start at the FRONT, whichever page you grabbed
    // from. The common move is "bring this forward", and starting on the page
    // you grabbed from puts that destination out of reach.
    this.layer.row1 = { mode: "move", page: 0, moveSource: sessionId };
    this.armMoveTimer();
    this.log.info({ session: sessionId }, "move: begin");
    this.onLayerChanged();
  }

  /** Pages of drop targets. Move mode always shows slots-1 targets (the last
   * key is Page/Cancel), so it can address positions the agents row can't —
   * with 5 sessions there IS a fifth position, and this is how you reach it. */
  private movePages(): number {
    const size = this.cfg.slots - 1;
    return Math.max(1, Math.ceil(this.registry.orderedEntries().length / size));
  }

  private pageMoveTargets(): void {
    this.layer.row1.page = (this.layer.row1.page + 1) % this.movePages();
    this.armMoveTimer(); // paging is intent, not idleness — restart the clock
    this.log.info({ page: this.layer.row1.page }, "move: paged drop targets");
    this.onLayerChanged();
  }

  /** `slot` is a key on the current page; the drop lands at that position in
   * the full ordered list, so a move can cross pages. */
  private completeMove(slot: number): void {
    const src = this.layer.row1.moveSource;
    if (src) {
      const targetIndex = this.layer.row1.page * (this.cfg.slots - 1) + slot;
      this.registry.moveToIndex(src, targetIndex);
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
    this.layer.row1 = { mode: "agents", page: this.layer.row1.page };
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
      if (isChoiceQuestion(suggestion.text)) {
        // No button answers "A, or B?" — the whole row is the question, and
        // any key talks. Tap, speak, tap to stop (or press Send to stop,
        // type, and submit in one motion).
        return void this.pttToggle();
      }
      void (async () => {
        if (index === 0) {
          const ok = await this.typeSubmit(suggestion.session, this.cfg.suggestionAcceptText);
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
    const name = entry.kind === "builtin" ? entry.id : entry.label;
    // A prompt on screen turns every command into a blind answer: the text
    // lands in a picker, and the Enter that follows ACCEPTS whatever was
    // highlighted. Claude Code publishes "waiting" while it blocks on input,
    // and we read it fresh from disk — so this catches prompts the deck never
    // saw, including ones raised before the bridge started. Unknown is not
    // safe, but refusing on unknown would break every provisional session, so
    // only an explicit "waiting" blocks.
    if (this.promptProbe(target.sessionId) === true) {
      this.log.warn(
        { key: name, session: target.sessionId },
        "row2 command refused: session is at a prompt — answer it first (Esc dismisses)",
      );
      return;
    }
    let ok = false;
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
    } else if (entry.kind === "builtin" && entry.id === "modemenu") {
      // Full picker on screen — desktop dialect only (the key renders blank
      // for consoles, but a stale press shouldn't fire a meaningless chord).
      if (target.windowKind === "desktop") {
        ok = await this.delivery.sendKey(target, "ctrl+shift+m");
      }
    } else if (entry.kind === "builtin" && entry.id === "rename") {
      await this.renameToggle(target); // second press stops the dictation
      ok = true;
    } else if (entry.kind === "builtin" && entry.id === "sendname") {
      // Push the button's name into Claude Code — the manual half of the
      // rename sync, for when the deck and the conversation drifted apart.
      // Console only: `/rename` must land in THIS session, and a desktop send
      // would retitle whichever conversation happens to be visible.
      if (target.windowKind === "console") {
        ok = await this.typeSubmit(target, `/rename ${target.labelBase}`);
      } else {
        this.log.warn({ session: target.sessionId }, "sendname ignored: desktop session isn't targeted exactly");
      }
    } else if (entry.kind === "keys") {
      ok = await this.sendChordsSpaced(target, entry.keys);
    } else if (entry.kind === "text" && entry.dictate) {
      // The argument IS the command here (/subtask, /btw, /goal): type the
      // prefix, leave the input open, and start listening. Send then ships
      // prefix + speech in one press.
      if (this.pttActive) {
        this.log.info({ key: name }, "dictate command ignored: already recording");
      } else {
        ok = await this.delivery.sendText(target, entry.text);
        if (ok) await this.pttToggle();
      }
    } else if (entry.kind === "text") {
      ok = await this.typeSubmit(target, entry.text);
      if (ok && entry.extraEnter) {
        // This Enter is unaimed, so it only ever fires at a prompt we can
        // actually SEE. Wait for the confirm to appear; if it never does — or
        // we can't tell — press nothing. Firing blind is what accepted an
        // unread plan once already.
        const prompted = await this.waitForPrompt(target.sessionId);
        if (prompted) ok = await this.delivery.sendKey(target, "enter");
        else this.log.warn({ key: name, session: target.sessionId }, "extraEnter skipped: no prompt to confirm");
      }
    }
    this.log.info({ key: name, session: target.sessionId, kind: target.windowKind, ok }, "row2 command");
  }

  /**
   * Type text and submit it, focus-free. ControlSend (console) and the
   * app-activate path inside sendText (desktop) both type without a prior
   * focus(); gating on focus() wrongly aborts bound-console delivery when the
   * foreground lock refuses activation, and running a command shouldn't yank
   * the window forward anyway.
   *
   * Desktop needs a beat between the text and Enter: the Electron app's
   * slash-command popup and input state render asynchronously, and an
   * instant Enter races them and is swallowed — the command sits untyped in
   * the box. Consoles are a raw byte stream and need no delay.
   */
  private async typeSubmit(target: SessionEntry, text: string): Promise<boolean> {
    if (!(await this.delivery.sendText(target, text))) return false;
    // Let the input settle before the Enter. Desktop needs the most (its
    // slash popup renders async). Consoles need a beat too once the text is
    // long: a 255-char dictation is 510 input records still draining when an
    // instant Enter lands behind them, and it gets absorbed as a newline
    // instead of submitting.
    const gap =
      target.windowKind === "desktop"
        ? (this.cfg.desktopSubmitDelayMs ?? 250)
        : CONSOLE_SUBMIT_GAP_MS;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    return this.delivery.sendKey(target, "enter");
  }

  /**
   * Send chords one at a time with a settle gap between them.
   *
   * Deliberately NOT delivery.sendSequence: that joins console chords into a
   * single write, and a Tab immediately followed by an Enter arrives before
   * the Tab's effect has rendered — the Enter then submits an input the Tab
   * hadn't filled yet. Each keystroke here lands on its own.
   */
  /** A slash command fired from a globals key. Same prompt guard as the
   * row-2 commands — typing at a picker answers it. */
  private async globalSlash(key: string, text: string): Promise<void> {
    const target = this.registry.targetedSession;
    if (!target) {
      this.log.warn({ key }, "row3 command ignored: no targeted session");
      return;
    }
    if (this.promptProbe(target.sessionId) === true) {
      this.log.warn({ key, session: target.sessionId }, "row3 command refused: session is at a prompt");
      return;
    }
    const ok = await this.typeSubmit(target, text);
    this.log.info({ key, session: target.sessionId, ok }, "row3 command");
  }

  private async sendChordsSpaced(target: SessionEntry, chords: string[]): Promise<boolean> {
    const gap =
      target.windowKind === "desktop" ? (this.cfg.desktopSubmitDelayMs ?? 250) : CONSOLE_SUBMIT_GAP_MS;
    for (const [i, chord] of chords.entries()) {
      if (i > 0 && gap > 0) await new Promise((r) => setTimeout(r, gap));
      if (!(await this.delivery.sendKey(target, chord))) return false;
    }
    return true;
  }

  private async cycleModel(target: SessionEntry): Promise<boolean> {
    if (target.windowKind === "console") {
      return this.typeSubmit(target, "/model");
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

  // --- Dictation (tap mic → record, tap again → stop & type; Send while
  // recording stops AND submits — a toggle, not a hold) ---

  private pttPressed = false; // down-edge seen; swallow the matching up
  private pttActive = false; // WE own the current stt recording (vs deny-reason)
  private pttTarget: SessionEntry | undefined;
  private pttMaxTimer: ReturnType<typeof setTimeout> | null = null;
  /** stop→transcribe→type in flight; Send awaits it so quick fingers still
   * submit the dictated text rather than an empty input. */
  private pttFlight: Promise<void> | null = null;

  private async pttToggle(): Promise<void> {
    const stt = this.stt;
    if (!stt) return;
    if (this.pttActive) return this.pttFinish(false); // second tap = stop & type
    // The mic key shows REC for ANY live dictation, so it has to end any of
    // them — a blinking mic that ignores a press is a broken promise.
    if (this.renameActive) return this.renameFinish();
    if (this.layer.permissionRec) {
      // Deny-reason owns the mic; route to the key that started it.
      this.hooks.onPermissionKey?.(3);
      return;
    }
    if (stt.status === "offline") {
      // Pressing the offline key is consent to retry the sidecar; a later
      // press records once it's ready.
      this.log.info("dictation: pressed while offline — retrying sidecar spawn");
      void stt.ensureStarted?.();
      return;
    }
    // "recording" here without pttActive = the deny-reason flow owns the mic.
    if (stt.status !== "ready") return;
    const target = this.registry.targetedSession;
    if (!target) {
      this.log.warn("dictation ignored: no targeted session");
      return;
    }
    this.pttTarget = target;
    this.pttActive = true; // claim before the await so a double-tap can't double-start
    if (await stt.start()) {
      // Send now means "stop, type, submit" — tell the key to say so.
      this.layer.talkActive = true;
      this.onLayerChanged();
      // Cap forgotten recordings: stop and type what we have at maxSeconds
      // (never auto-SENDS — submitting is always an explicit Send press).
      this.pttMaxTimer = setTimeout(() => void this.pttFinish(false), this.cfg.ptt.maxSeconds * 1000);
    } else {
      this.pttActive = false;
      this.pttTarget = undefined;
    }
  }

  /** Stop the dictation, type the transcription into the press-time target
   * (unsent), and — when `send` — follow with Enter. */
  private async pttFinish(send: boolean): Promise<void> {
    const stt = this.stt;
    if (!stt || !this.pttActive) return;
    this.pttActive = false;
    this.layer.talkActive = undefined; // Send goes back to a plain Enter
    this.onLayerChanged();
    if (this.pttMaxTimer) {
      clearTimeout(this.pttMaxTimer);
      this.pttMaxTimer = null;
    }
    const target = this.pttTarget;
    this.pttTarget = undefined;
    const flight = (async () => {
      const text = await stt.stop();
      // Target from recording-start time; skip if it vanished mid-utterance.
      const live = target && this.registry.get(target.sessionId) ? target : undefined;
      let ok = false;
      // Route the submitting case through typeSubmit so dictation gets the
      // same settle gap every other typed command does — going straight to
      // sendText+sendKey left no gap at all and the Enter landed as a
      // newline instead of submitting.
      if (text && live) ok = send ? await this.typeSubmit(live, text) : await this.delivery.sendText(live, text);
      if (!text) this.log.info("dictation: empty transcription");
      else this.log.info({ chars: text.length, session: live?.sessionId, send, ok }, "dictation: typed");
      // Send-while-recording submits even when the transcription came back
      // empty — the press meant "ship what's in the input".
      if (send && live && !text) await this.delivery.sendKey(live, "enter");
    })();
    this.pttFlight = flight.finally(() => {
      if (this.pttFlight === flight) this.pttFlight = null;
    });
    await flight;
  }

  // --- Rename (speak a session's real name once the feature has one) ---

  private renameActive = false;
  private renameTarget: SessionEntry | undefined;
  private renameMaxTimer: ReturnType<typeof setTimeout> | null = null;

  /** Rename key: tap to dictate a name for the targeted session, tap again
   * to stop early. Renames the deck branch when it owns one (so the PR gets
   * the good name too), else sets a display-only override. */
  private async renameToggle(explicit?: SessionEntry): Promise<void> {
    const stt = this.stt;
    if (!stt) return;
    if (this.renameActive) return this.renameFinish();
    if (stt.status === "offline") {
      this.log.info("rename pressed while offline — retrying sidecar spawn");
      void stt.ensureStarted?.();
      return;
    }
    if (stt.status !== "ready") return; // busy with another dictation
    const target = explicit ?? this.registry.targetedSession;
    if (!target) {
      this.log.warn("rename ignored: no targeted session");
      return;
    }
    this.renameTarget = target;
    this.renameActive = true;
    if (await stt.start()) {
      const seconds = this.cfg.ptt.renameMaxSeconds;
      this.layer.renameRec = {
        deadline: Date.now() + seconds * 1000,
        label: target.label,
        sessionId: target.sessionId,
      };
      this.renameMaxTimer = setTimeout(() => void this.renameFinish(), seconds * 1000);
      this.log.info({ session: target.sessionId, seconds }, "rename: recording");
      this.onLayerChanged();
    } else {
      this.renameActive = false;
      this.renameTarget = undefined;
    }
  }

  private async renameFinish(): Promise<void> {
    const stt = this.stt;
    if (!stt || !this.renameActive) return;
    this.renameActive = false;
    if (this.renameMaxTimer) {
      clearTimeout(this.renameMaxTimer);
      this.renameMaxTimer = null;
    }
    const target = this.renameTarget;
    this.renameTarget = undefined;
    this.layer.renameRec = undefined;
    this.onLayerChanged();

    const spoken = await stt.stop();
    const named = slugifyName(spoken);
    // Session gone mid-utterance, or nothing usable came back → no change.
    if (!named || !target || !this.registry.get(target.sessionId)) {
      this.log.info({ spoken }, "rename: nothing usable — name unchanged");
      return;
    }
    const branch = gitBranch(target.cwd);
    let viaBranch = false;
    if (isDeckBranch(branch)) {
      // Rename the real artifact; the 30s label sweep would catch it anyway,
      // but refresh now so the key updates immediately.
      viaBranch = await renameDeckBranch(target.cwd, branch!, `deck/${named.slug}`, this.log);
      if (viaBranch) {
        // Carry the new name as the CC name too. A previously-adopted
        // `/rename` outranks the branch, so refreshing without it would leave
        // the button on the OLD name until the next 30s sweep read the new
        // one back — and we're about to make Claude Code agree anyway.
        this.registry.refreshLabels(new Map([[target.sessionId, named.label]]));
        this.log.info({ session: target.sessionId, branch: `deck/${named.slug}` }, "rename: applied via branch");
      }
    }
    if (!viaBranch) {
      // Not ours to rewrite (real feature branch, non-git dir, desktop app) or
      // the rename failed → name the button only.
      this.registry.setLabelOverride(target.sessionId, named.label);
      this.onSessionRenamed?.(target);
      this.log.info({ session: target.sessionId, label: named.label }, "rename: applied as label override");
    }
    // Carry the name into Claude Code itself so the conversation, the branch,
    // and the button all agree. Console only: `/rename` has to land in THIS
    // session, and only console sessions are targeted exactly (a desktop send
    // would retitle whichever conversation happens to be visible).
    if (target.windowKind === "console") {
      const ok = await this.typeSubmit(target, `/rename ${named.label}`);
      this.log.info({ session: target.sessionId, name: named.label, ok }, "rename: pushed /rename to the session");
    }
  }

  /** Row 3: mic / interrupt / globals; the Page key flips global pages. */
  private async row3(index: number): Promise<void> {
    const target = this.registry.targetedSession;
    if (index === 4 && HAS_GLOBALS_PAGE2) {
      // Page — only while page 2 holds something; otherwise this key is
      // Resume (see the switch below).
      this.layer.row3Page = this.layer.row3Page === 0 ? 1 : 0;
      this.onLayerChanged();
      return;
    }
    if (this.layer.row3Page === 1) {
      // Page 2 — the session-creation verbs that aren't the everyday New.
      if (index === 0) return void (await this.resumeSession());
      if (index === 1) return void (await this.globalSlash("Fork", "/fork"));
      if (index === 2) return void (await this.globalSlash("Branch", "/branch"));
      return;
    }
    switch (index) {
      case 0: // Mic — handled at the raw down/up layer (toggle);
        return; // a stray classified gesture here is a no-op.
      case 1:
        // Send: mid-dictation → stop, type, AND submit in one press; while
        // the transcription is still landing → wait, then submit; otherwise
        // a plain Enter. (A deny-reason recording is not ours to send.)
        if (this.pttActive) return void (await this.pttFinish(true));
        if (this.pttFlight) await this.pttFlight;
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

  /**
   * Resume — `claude --resume` in a console, which opens Claude Code's own
   * session picker. Deliberately NO worktree: you're picking up work that
   * already exists, and a fresh empty branch is the wrong place to land it.
   * Same global-key rules as New (works untargeted, one launch at a time).
   */
  private async resumeSession(): Promise<void> {
    const dir = this.registry.targetedSession?.cwd ?? this.cfg.newSessionDir;
    if (!dir) {
      this.log.warn("Resume ignored: no targeted session and no newSessionDir configured");
      return;
    }
    if (this.layer.launching) {
      this.log.info("Resume ignored: launch already in flight");
      return;
    }
    this.layer.launching = true;
    this.onLayerChanged();
    try {
      const ok =
        (await this.launcher?.launch(dir, {
          command: `${this.cfg.newSessionCommand} --resume`,
          worktree: false,
        })) ?? false;
      this.log.info({ key: "Resume", cwd: dir, ok }, "row3 command");
    } finally {
      this.layer.launching = false;
      this.onLayerChanged();
    }
  }
}
