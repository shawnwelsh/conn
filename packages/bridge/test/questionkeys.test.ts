import { describe, expect, it } from "vitest";
import { deliverQuestionAnswer } from "../src/questionKeys.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";

const session: SessionRef = { sessionId: "s", cwd: "C:\\dev\\s", label: "s", pid: 1 };

class Rec implements DeliveryAdapter {
  calls: string[] = [];
  async focus(): Promise<boolean> { this.calls.push("focus"); return true; }
  async sendText(): Promise<boolean> { return true; }
  async sendKey(_s: SessionRef, c: string): Promise<boolean> { this.calls.push(`key:${c}`); return true; }
  async sendSequence(): Promise<boolean> { return true; }
  async findWindowByPid(): Promise<number | null> { return null; }
  async checkWindow(): Promise<boolean | null> { return null; }
  async dispose(): Promise<void> {}
}

describe("deliverQuestionAnswer", () => {
  it("a NON-last answer sends the number ONLY — no key to corrupt the next question", async () => {
    // number+key per question would advance Claude by two (the key answering
    // the next question's default) but the deck by one, drifting a question
    // behind. The number alone selects AND advances.
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 2, false, true, 0);
    expect(d.calls).toEqual(["focus", "key:2"]);
  });

  it("the LAST answer of a MULTI-question ask presses '1' on the Submit step, not Enter", async () => {
    // The bug: Claude's multi-question form ends on a digit-selected
    // "Submit answers / Cancel" step; Enter is ignored there, so it parked.
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 2, true, true, 0);
    expect(d.calls).toEqual(["focus", "key:2", "key:1"]);
  });

  it("a SINGLE-question ask submits on the number — trailing key is a harmless Enter", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 3, true, false, 0);
    expect(d.calls).toEqual(["focus", "key:3", "key:enter"]);
  });

  it("stops if the number keystroke fails", async () => {
    const d = new Rec();
    d.sendKey = async (_s, c) => {
      d.calls.push(`key:${c}`);
      return false;
    };
    const ok = await deliverQuestionAnswer(d, session, 3, true, true, 0);
    expect(ok).toBe(false);
    expect(d.calls).toEqual(["focus", "key:3"]); // never reached the submit key
  });
});
