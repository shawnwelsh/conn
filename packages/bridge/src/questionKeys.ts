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
