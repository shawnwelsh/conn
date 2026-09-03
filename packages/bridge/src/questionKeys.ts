import type { DeliveryAdapter, SessionRef } from "./delivery/adapter.js";

/**
 * Deliver one AskUserQuestion answer to a console.
 *
 * Claude Code's question menu is ARROW-NAVIGATED: a highlight starts on option
 * 1, ↑/↓ moves it, and Enter selects — which also advances to the next question
 * or submits. It IGNORES number keys entirely. (An earlier version typed the
 * option digit; the keystroke injected fine — "ok" — but the menu did nothing
 * with it, so answers silently never landed.) So per question we step the
 * highlight DOWN to the chosen option, then press Enter.
 *
 *  - Non-last question: ↓×(n-1) + Enter selects and moves to the next question.
 *  - SINGLE-question ask: that Enter submits the answer directly.
 *  - MULTI-question ask: after the last option's Enter, Claude lands on a
 *    "Submit answers" step (Submit is the highlighted default) — one more Enter
 *    ships the whole form.
 *
 * We do NOT force focus first: console delivery injects into the input buffer
 * focus-free, and sendKey already activates the window itself for desktop
 * sessions. (Gating on focus — now only best-effort — was another way answers
 * could quietly die.)
 */
export async function deliverQuestionAnswer(
  delivery: DeliveryAdapter,
  session: SessionRef,
  optionNumber: number, // 1-based menu position; the highlight starts on 1
  isLast: boolean,
  multi: boolean, // the ask has >1 question → a "Submit answers" step follows
  gapMs = 80,
): Promise<boolean> {
  // Step the highlight down from option 1 to the chosen option.
  for (let i = 1; i < optionNumber; i++) {
    if (!(await delivery.sendKey(session, "down"))) return false;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  // Enter selects this question's option (and advances, or submits).
  if (!(await delivery.sendKey(session, "enter"))) return false;
  if (!isLast || !multi) return true;
  // Multi-question ask: that Enter advanced to the "Submit answers" step. Let it
  // render (a fresh screen), then Enter on the highlighted Submit to ship it.
  await new Promise((r) => setTimeout(r, gapMs * 3));
  return delivery.sendKey(session, "enter");
}

/**
 * Bring a DESKTOP session's conversation to the front before answering it.
 *
 * The Claude app is ONE window (title just "Claude") with every conversation as
 * a tab, so there is no per-session hwnd to target and no title to match. Keys
 * sent to it land in whichever conversation was last on screen — which is how a
 * question displayed correctly on the deck could be answered into a different
 * chat entirely, reporting ok the whole way.
 *
 * The app's own search is the only handle we have:
 *   Ctrl+1        jump to the pinned first chat. REQUIRED: the search omits the
 *                 conversation you are already in, so without this the target
 *                 may not be listed at all.
 *   Ctrl+Shift+K  open search
 *   <name>        type it, then WAIT — the results need a beat to settle, and
 *                 an early Enter takes whatever row was there first
 *   Enter         jump
 *
 * Only ever called with `ccName` — Claude Code's own name for the conversation,
 * which is what the app calls it too. A cwd-derived deck label ("Home", a branch
 * name) is a string the app has never heard of, and searching it would land on
 * an arbitrary chat and answer THAT. Callers must refuse instead.
 */
export async function focusDesktopConversation(
  delivery: DeliveryAdapter,
  session: SessionRef,
  gapMs = 350,
  settleMs = 1000,
  trace?: string[],
): Promise<boolean> {
  const name = session.ccName;
  if (!name) return false; // never guess at a name the app does not use
  const pause = (ms = gapMs) => new Promise((r) => setTimeout(r, ms));
  const send = async (chord: string): Promise<boolean> => {
    const ok = await delivery.sendKey(session, chord);
    trace?.push(ok ? chord : `${chord}:FAILED`);
    return ok;
  };
  if (!(await send("ctrl+1"))) return false;
  await pause();
  if (!(await send("ctrl+shift+k"))) return false;
  await pause();
  if (!(await delivery.sendText(session, name))) {
    trace?.push("search:FAILED");
    return false;
  }
  trace?.push(`search:${name}`);
  await pause(settleMs); // results settle, or Enter picks the wrong conversation
  if (!(await send("enter"))) return false;
  await pause(settleMs); // let the conversation render before we answer into it
  return true;
}

/**
 * Deliver a MULTI-SELECT question answer to a console.
 *
 * The form's own footer states its key model, and it is NOT the single-select
 * one: "Enter to select · Tab/Arrow keys to navigate". Concretely —
 *
 *   ↑/↓    move the highlight within a question group
 *   SPACE  toggles the box under it
 *   ENTER  on an option row is a SYNONYM FOR SPACE — it toggles, it does not
 *          proceed. This is the trap: the obvious "finish with Enter" lands on
 *          the last option you picked and turns it back OFF.
 *   TAB    leaves the option list — to the next question group, and from the
 *          last group onto the Submit tab
 *   ENTER  on the Submit tab means "Submit Answers"
 *
 * So we walk DOWN to each chosen option (in menu order), Space it, then Tab
 * out; the final question Tabs onto Submit and Enters there. The deck tracked
 * which boxes you toggled and this replays them in one go.
 *
 * Getting this wrong was invisible from our side: every keystroke reported ok,
 * because injection only confirms writing to the input buffer — never that the
 * TUI did what we meant by it.
 */
export async function deliverMultiSelectAnswer(
  delivery: DeliveryAdapter,
  session: SessionRef,
  checked: number[], // 0-based option indices toggled ON, any order
  isLast: boolean,
  /** The ask has >1 question → the DESKTOP app lands on a "Submit answers"
   * step after the last one. Unused by the console dialect, which reaches
   * Submit by Tab instead. */
  multi: boolean,
  /**
   * Gap between keystrokes. A key can report ok while the CONSOLE still drops
   * it: injection writes into the input buffer far faster than an Ink TUI
   * re-renders a checkbox list.
   */
  gapMs = 140,
  /** Keystroke-by-keystroke record, so a bad run can be read back rather than
   * guessed at. `chord:FAILED` marks one the adapter itself rejected. */
  trace?: string[],
): Promise<boolean> {
  const send = async (chord: string): Promise<boolean> => {
    const ok = await delivery.sendKey(session, chord);
    trace?.push(ok ? chord : `${chord}:FAILED`);
    return ok;
  };
  const pause = () => new Promise((r) => setTimeout(r, gapMs));

  let cursor = 0; // the highlight starts on option 1
  for (const idx of [...checked].sort((a, b) => a - b)) {
    for (; cursor < idx; cursor++) {
      if (!(await send("down"))) return false;
      await pause();
    }
    if (!(await send("space"))) return false;
    await pause();
  }
  await pause(); // let the last toggle finish painting

  // THE TAIL IS DIALECT-SPECIFIC. The toggles above are common to both UIs;
  // how you leave the list is not, and sending the console's tail to the
  // desktop app broke answering there entirely.
  if (session.windowKind === "desktop") {
    // Claude app (Electron): ordinary focusable controls — Enter proceeds, and
    // a multi-question ask ends on a "Submit answers" step needing one more.
    if (!(await send("enter"))) return false;
    if (!isLast || !multi) return true;
    await new Promise((r) => setTimeout(r, gapMs * 3));
    return send("enter");
  }

  // Console TUI: TAB, never Enter. Here Enter is a SYNONYM FOR SPACE on an
  // option row, so a closing Enter re-toggles the last thing you picked and
  // silently un-picks it — "I chose four and only three were ticked", with the
  // form left unsubmitted. Tab leaves the option list: to the next question
  // group, or from the last group onto the Submit tab.
  if (!(await send("tab"))) return false;
  if (!isLast) return true;
  await pause();
  // Only there, on the Submit tab, does Enter mean "Submit Answers".
  return send("enter");
}
