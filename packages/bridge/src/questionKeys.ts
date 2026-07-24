import type { DeliveryAdapter, SessionRef } from "./delivery/adapter.js";

/**
 * Deliver one AskUserQuestion answer to a console.
 *
 * Claude's console form advances on the NUMBER alone — pressing the option
 * digit both selects that question's answer AND moves to the next question. So
 * per question we send ONLY the number. An Enter here would answer the *next*
 * question with its highlighted default (that was an earlier bug: number+Enter
 * per question advanced Claude by two but the deck by one, drifting a question
 * behind and corrupting the form).
 *
 * The last answer depends on how many questions there were:
 *  - MULTI-question ask (`multi`): after the last number, Claude sits on a
 *    "Submit answers / Cancel" step that is ALSO digit-selected — press "1".
 *    Enter does NOT submit it (verified live: the form parked on Submit until
 *    "1" was pressed). This was the bug.
 *  - SINGLE-question ask: the option number submits the answer directly (there
 *    is no Submit step), so the trailing key is a harmless Enter — kept as-is,
 *    which is why single-question asks always worked.
 */
export async function deliverQuestionAnswer(
  delivery: DeliveryAdapter,
  session: SessionRef,
  optionNumber: number, // 1-based, as shown in the menu
  isLast: boolean,
  multi: boolean, // the ask has >1 question → a "Submit answers" step follows
  gapMs = 200,
): Promise<boolean> {
  if (!(await delivery.focus(session))) return false;
  if (!(await delivery.sendKey(session, String(optionNumber)))) return false;
  // Non-last: the number alone advanced Claude to the next question — done.
  if (!isLast) return true;
  // Last: let Claude settle on the next step, then finish it. Multi → press "1"
  // on the Submit step; single → a harmless Enter (it already submitted).
  await new Promise((r) => setTimeout(r, gapMs));
  return delivery.sendKey(session, multi ? "1" : "enter");
}
