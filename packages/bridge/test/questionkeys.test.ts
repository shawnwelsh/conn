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
  it("single answer: focus, number, one Enter — no extra submit", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 2, false, 0);
    expect(d.calls).toEqual(["focus", "key:2", "key:enter"]);
  });

  it("last of a multi-question form: a SECOND Enter presses 'Submit answers'", async () => {
    // The bug: after answering both questions the console left 'Submit
    // answers' waiting, because the per-question Enter only confirms/advances.
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 1, true, 0);
    expect(d.calls).toEqual(["focus", "key:1", "key:enter", "key:enter"]);
  });

  it("stops (and skips submit) if a keystroke fails", async () => {
    const d = new Rec();
    d.sendKey = async (_s, c) => {
      d.calls.push(`key:${c}`);
      return c !== "enter"; // first Enter fails
    };
    const ok = await deliverQuestionAnswer(d, session, 3, true, 0);
    expect(ok).toBe(false);
    expect(d.calls).toEqual(["focus", "key:3", "key:enter"]); // no submit Enter
  });
});
