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
  it("a NON-last answer sends the number ONLY — no Enter to corrupt the next question", async () => {
    // The bug: number+Enter per question advanced Claude by two (the Enter
    // answered the next question's default) but the deck by one, drifting a
    // question behind. The number alone selects AND advances.
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 2, false, 0);
    expect(d.calls).toEqual(["focus", "key:2"]);
  });

  it("the LAST answer sends number then one Enter to press 'Submit answers'", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 1, true, 0);
    expect(d.calls).toEqual(["focus", "key:1", "key:enter"]);
  });

  it("a single-question ask is 'last' too — number then submit Enter", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 3, true, 0);
    expect(d.calls).toEqual(["focus", "key:3", "key:enter"]);
  });

  it("stops if the number keystroke fails", async () => {
    const d = new Rec();
    d.sendKey = async (_s, c) => {
      d.calls.push(`key:${c}`);
      return false;
    };
    const ok = await deliverQuestionAnswer(d, session, 3, true, 0);
    expect(ok).toBe(false);
    expect(d.calls).toEqual(["focus", "key:3"]); // never reached the submit Enter
  });
});
