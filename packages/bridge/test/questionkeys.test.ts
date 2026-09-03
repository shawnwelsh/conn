import { describe, expect, it } from "vitest";
import { deliverQuestionAnswer, deliverMultiSelectAnswer, focusDesktopConversation } from "../src/questionKeys.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";

const session: SessionRef = { sessionId: "s", cwd: "C:\\dev\\s", label: "s", pid: 1 };

class Rec implements DeliveryAdapter {
  calls: string[] = [];
  async focus(): Promise<boolean> { this.calls.push("focus"); return true; }
  async sendText(_s: SessionRef, _t: string): Promise<boolean> { return true; }
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

// The Claude app is ONE window holding every conversation as a tab, so an
// unfocused answer lands in whatever chat was last on screen — reporting ok the
// whole way. Its search is the only handle we have.
describe("focusDesktopConversation", () => {
  class RecText extends Rec {
    async sendText(_s: SessionRef, t: string): Promise<boolean> { this.calls.push(`text:${t}`); return true; }
  }

  it("Ctrl+1 first, then search, type the name, and Enter", async () => {
    // Ctrl+1 is load-bearing: the app's search omits the conversation you are
    // ALREADY in, so without it the target may never be listed.
    const d = new RecText();
    const ok = await focusDesktopConversation(
      d, { sessionId: "s", cwd: "C:/x", label: "finance report", ccName: "finance report", windowKind: "desktop" }, 0, 0,
    );
    expect(ok).toBe(true);
    expect(d.calls).toEqual(["key:ctrl+1", "key:ctrl+shift+k", "text:finance report", "key:enter"]);
  });

  it("REFUSES when Claude Code has no name for the conversation", async () => {
    // A cwd-derived label ("Home", a branch name) is a string the app has never
    // heard of. Searching it would land on an arbitrary chat and answer THAT.
    const d = new RecText();
    const ok = await focusDesktopConversation(
      d, { sessionId: "s", cwd: "C:/x", label: "Home", windowKind: "desktop" }, 0, 0,
    );
    expect(ok).toBe(false);
    expect(d.calls).toEqual([]); // not a single key sent
  });

  it("stops as soon as a keystroke is refused", async () => {
    const d = new RecText();
    d.sendKey = async (_s, c) => { d.calls.push(`key:${c}`); return c !== "ctrl+shift+k"; };
    const ok = await focusDesktopConversation(
      d, { sessionId: "s", cwd: "C:/x", label: "x", ccName: "x", windowKind: "desktop" }, 0, 0,
    );
    expect(ok).toBe(false);
    expect(d.calls).toEqual(["key:ctrl+1", "key:ctrl+shift+k"]);
  });
});

// The multi-select form's own footer: "Enter to select · Tab/Arrow keys to
// navigate". ↓ moves, SPACE toggles, ENTER on an option row TOGGLES TOO, TAB
// leaves the group, and only Enter on the Submit tab submits.
describe("deliverMultiSelectAnswer (checkbox menu)", () => {
  const consoleSession: SessionRef = { ...session, windowKind: "console" };
  const desktopSession: SessionRef = { ...session, windowKind: "desktop" };

  // The Claude app is an Electron UI, not the Ink TUI — Enter proceeds there.
  // Firing the console's Tab tail at it broke answering from the deck outright.
  describe("desktop dialect (Claude app)", () => {
    it("finishes with Enter, not Tab", async () => {
      const d = new Rec();
      await deliverMultiSelectAnswer(d, desktopSession, [0, 2], true, false, 0);
      expect(d.calls).toEqual(["key:space", "key:down", "key:down", "key:space", "key:enter"]);
      expect(d.calls).not.toContain("key:tab");
    });

    it("adds the Submit-step Enter on the last of a multi-question ask", async () => {
      const d = new Rec();
      await deliverMultiSelectAnswer(d, desktopSession, [0], true, true, 0);
      expect(d.calls).toEqual(["key:space", "key:enter", "key:enter"]);
    });

    it("a non-last question just proceeds", async () => {
      const d = new Rec();
      await deliverMultiSelectAnswer(d, desktopSession, [0], false, true, 0);
      expect(d.calls).toEqual(["key:space", "key:enter"]);
    });
  });

  it("console: walks down to each checked option, Spaces it, then Tabs out", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, consoleSession, [0, 2], true, false, 0);
    // cursor starts on option 1: toggle 0 in place, ↓↓ to 2, toggle, Tab to
    // Submit, Enter there.
    expect(d.calls).toEqual([
      "key:space", "key:down", "key:down", "key:space", "key:tab", "key:enter",
    ]);
  });

  it("sorts the taps so cursor moves are minimal and correct regardless of tap order", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, consoleSession, [2, 0], true, false, 0);
    expect(d.calls).toEqual([
      "key:space", "key:down", "key:down", "key:space", "key:tab", "key:enter",
    ]);
  });

  // THE regression that started this: Enter is a synonym for Space on an
  // option row, so finishing with Enter un-picked the last choice. Four
  // selected, three ticked, form left unsubmitted.
  it("NEVER presses Enter while the cursor is on an option row", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, consoleSession, [0, 1, 2], true, false, 0);
    const enterAt = d.calls.indexOf("key:enter");
    const tabAt = d.calls.indexOf("key:tab");
    expect(tabAt).toBeGreaterThan(-1);
    expect(enterAt).toBeGreaterThan(tabAt); // the only Enter comes after Tab
    expect(d.calls.filter((c) => c === "key:enter")).toHaveLength(1);
  });

  it("a non-last question Tabs to the next group and stops — no Enter at all", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, consoleSession, [0], false, false, 0);
    expect(d.calls).toEqual(["key:space", "key:tab"]);
  });

  it("nothing checked still Tabs out rather than pressing Enter on an option", async () => {
    const d = new Rec();
    await deliverMultiSelectAnswer(d, consoleSession, [], true, false, 0);
    expect(d.calls).toEqual(["key:tab", "key:enter"]);
  });

  // A summary line ("picked: 4, ok: true") looked perfect on a run where the
  // console had actually swallowed a toggle. The trace is what makes the next
  // bad run readable instead of guesswork.
  it("records the exact keystrokes in order", async () => {
    const d = new Rec();
    const trace: string[] = [];
    await deliverMultiSelectAnswer(d, consoleSession, [0, 2], true, false, 0, trace);
    expect(trace).toEqual(["space", "down", "down", "space", "tab", "enter"]);
  });

  it("marks a keystroke the adapter rejected, and stops there", async () => {
    const d = new Rec();
    d.sendKey = async (_s, c) => { d.calls.push(`key:${c}`); return c !== "space"; };
    const trace: string[] = [];
    const ok = await deliverMultiSelectAnswer(d, consoleSession, [1], true, false, 0, trace);
    expect(ok).toBe(false);
    expect(trace).toEqual(["down", "space:FAILED"]);
  });
});
