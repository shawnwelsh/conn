import { describe, expect, it } from "vitest";
import { deliverQuestionAnswer, deliverMultiSelectAnswer } from "../src/questionKeys.js";
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

// Claude Code's question menu is arrow-navigated: the highlight starts on
// option 1, so answering is ↓×(n-1) then Enter — and never a number key, and
// never a forced focus first (console delivery is focus-free).
describe("deliverQuestionAnswer (arrow-navigated menu)", () => {
  it("option 1 is a bare Enter — the highlight already sits there", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 1, true, false, 0);
    expect(d.calls).toEqual(["key:enter"]);
  });

  it("steps DOWN to the chosen option, then Enter", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 3, true, false, 0); // option 3, single-question
    expect(d.calls).toEqual(["key:down", "key:down", "key:enter"]);
  });

  it("a NON-last answer selects and stops (the Enter advances Claude itself)", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 2, false, true, 0);
    expect(d.calls).toEqual(["key:down", "key:enter"]);
  });

  it("the LAST answer of a MULTI-question ask adds an Enter for the Submit step", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 2, true, true, 0);
    expect(d.calls).toEqual(["key:down", "key:enter", "key:enter"]);
  });

  it("never types a digit and never forces focus", async () => {
    const d = new Rec();
    await deliverQuestionAnswer(d, session, 4, true, false, 0);
    expect(d.calls).not.toContain("focus");
    expect(d.calls.some((c) => /^key:[0-9]$/.test(c))).toBe(false);
  });

  it("stops if a keystroke fails — no submit key after a failed select", async () => {
    const d = new Rec();
    d.sendKey = async (_s, c) => { d.calls.push(`key:${c}`); return c !== "enter"; };
    const ok = await deliverQuestionAnswer(d, session, 3, true, true, 0);
    expect(ok).toBe(false);
    expect(d.calls).toEqual(["key:down", "key:down", "key:enter"]);
  });
});

// Multi-select is a checkbox list: ↓ to move, SPACE to toggle, ENTER to
// proceed. The deck tracks which boxes you tapped and replays them in one go.
describe("deliverMultiSelectAnswer (checkbox menu)", () => {
  it("walks down to each checked option in menu order, Spaces it, then Enter", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, session, [0, 2], true, false, 0);
    // cursor starts on option 1: toggle 0 in place, ↓↓ to 2, toggle, Enter.
    expect(d.calls).toEqual(["key:space", "key:down", "key:down", "key:space", "key:enter"]);
  });

  it("sorts the taps so cursor moves are minimal and correct regardless of tap order", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, session, [2, 0], true, false, 0);
    expect(d.calls).toEqual(["key:space", "key:down", "key:down", "key:space", "key:enter"]);
  });

  it("a single checked option: down to it, Space, Enter", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, session, [1], true, false, 0);
    expect(d.calls).toEqual(["key:down", "key:space", "key:enter"]);
  });

  it("nothing checked is a bare Enter (submit with no picks)", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, session, [], true, false, 0);
    expect(d.calls).toEqual(["key:enter"]);
  });

  it("a NON-last multi-select answer proceeds without the extra Submit-step Enter", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, session, [0], false, true, 0);
    expect(d.calls).toEqual(["key:space", "key:enter"]);
  });

  it("the LAST answer of a MULTI-question ask adds the Submit-step Enter", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, session, [0], true, true, 0);
    expect(d.calls).toEqual(["key:space", "key:enter", "key:enter"]);
  });
});
