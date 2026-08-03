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
 * Deliver a MULTI-SELECT question answer to a console.
 *
 * Claude Code renders these as a checkbox list: ↑/↓ moves the highlight, SPACE
 * toggles the box under it, ENTER proceeds. The highlight starts on option 1,
 * so we walk DOWN to each chosen option (in menu order), Space it, then Enter.
 * The deck tracked which boxes you toggled; this replays them in one go.
 *
 *  - Single-question ask: that Enter submits.
 *  - MULTI-question ask: the last question's Enter lands on the "Submit answers"
 *    step, so one more Enter ships it (same tail as the single-select path).
 */
export async function deliverMultiSelectAnswer(
  delivery: DeliveryAdapter,
  session: SessionRef,
  checked: number[], // 0-based option indices toggled ON, any order
  isLast: boolean,
  multi: boolean, // the ask has >1 question → a "Submit answers" step follows
  gapMs = 80,
): Promise<boolean> {
  let cursor = 0; // the highlight starts on option 1
  for (const idx of [...checked].sort((a, b) => a - b)) {
    for (; cursor < idx; cursor++) {
      if (!(await delivery.sendKey(session, "down"))) return false;
      await new Promise((r) => setTimeout(r, gapMs));
    }
    if (!(await delivery.sendKey(session, "space"))) return false;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  // Enter proceeds — submits this question's picks (or advances to the next).
  if (!(await delivery.sendKey(session, "enter"))) return false;
  if (!isLast || !multi) return true;
  await new Promise((r) => setTimeout(r, gapMs * 3));
  return delivery.sendKey(session, "enter");
}
