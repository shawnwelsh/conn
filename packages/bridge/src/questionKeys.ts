import type { DeliveryAdapter, SessionRef } from "./delivery/adapter.js";

/**
 * Deliver one AskUserQuestion answer to a console: focus, type the 1-based
 * option number, Enter to confirm.
 *
 * Claude's multi-question form confirms each question with that Enter and
 * advances; after the LAST question it lands on a "Submit answers" step that
 * needs one more Enter. So on the final answer of a multi-question ask we send
 * a second Enter to press Submit. Single-question asks submit on the first
 * Enter (there's nothing to advance past), so the extra Enter is gated to
 * `submitAfter` — never a blind Enter into whatever state the console is in.
 */
export async function deliverQuestionAnswer(
  delivery: DeliveryAdapter,
  session: SessionRef,
  optionNumber: number, // 1-based, as shown in the menu
  submitAfter: boolean,
  gapMs = 250,
): Promise<boolean> {
  if (!(await delivery.focus(session))) return false;
  if (!(await delivery.sendKey(session, String(optionNumber)))) return false;
  if (!(await delivery.sendKey(session, "enter"))) return false;
  if (submitAfter) {
    // Let the "Submit answers" step render before pressing it.
    await new Promise((r) => setTimeout(r, gapMs));
    return delivery.sendKey(session, "enter");
  }
  return true;
}
