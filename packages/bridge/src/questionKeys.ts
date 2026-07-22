import type { DeliveryAdapter, SessionRef } from "./delivery/adapter.js";

/**
 * Deliver one AskUserQuestion answer to a console.
 *
 * Claude's console form advances on the NUMBER alone — pressing the option
 * digit both selects that question's answer AND moves to the next question. So
 * per question we send ONLY the number. An Enter here would answer the *next*
 * question with its highlighted default (that was the bug: number+Enter per
 * question advanced Claude by two but the deck by one, drifting a question
 * behind and corrupting the form).
 *
 * After the LAST question's number, Claude sits on its "Submit answers" step;
 * one Enter presses it. That's the only Enter, and it's gated to `isLast` — for
 * a single-question ask the sole question is also the last, so it too gets
 * number-then-Enter, which is why single questions always worked.
 */
export async function deliverQuestionAnswer(
  delivery: DeliveryAdapter,
  session: SessionRef,
  optionNumber: number, // 1-based, as shown in the menu
  isLast: boolean,
  gapMs = 200,
): Promise<boolean> {
  if (!(await delivery.focus(session))) return false;
  if (!(await delivery.sendKey(session, String(optionNumber)))) return false;
  // Non-last: the number alone advanced Claude to the next question — done.
  if (!isLast) return true;
  // Last: the number advanced to "Submit answers"; let it render, then submit.
  await new Promise((r) => setTimeout(r, gapMs));
  return delivery.sendKey(session, "enter");
}
