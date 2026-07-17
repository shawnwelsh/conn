import { describe, expect, it } from "vitest";
import { SessionRegistry, deriveLabel, prettifyBranch } from "../src/registry.js";

function start(registry: SessionRegistry, id: string, cwd = `C:\\dev\\${id}`) {
  return registry.ensure({ session_id: id, cwd, hook_event_name: "SessionStart" });
}

describe("prettifyBranch (feature name)", () => {
  it("drops the namespace prefix, trailing hash, and date; hyphens→spaces", () => {
    expect(prettifyBranch("claude/stream-deck-claude-code-736eec")).toBe("stream deck claude code");
    expect(prettifyBranch("feature/sfdc-quote-fix-2026-07-16")).toBe("sfdc quote fix");
    expect(prettifyBranch("claude/new-session-testing-0212d5")).toBe("new session testing");
    expect(prettifyBranch("bugfix/login_flow")).toBe("login flow");
  });
});

describe("deriveLabel", () => {
  it("falls back to the cwd leaf for non-git dirs", () => {
    // These temp-ish paths aren't git repos, so we get the leaf directory.
    expect(deriveLabel("C:\\nope\\not-a-repo-xyz")).toBe("not-a-repo-xyz");
    expect(deriveLabel(undefined)).toBe("session");
  });
});

describe("duplicate label disambiguation", () => {
  it("suffixes sessions that resolve to the same feature name", () => {
    const r = new SessionRegistry(5);
    const a = r.ensure({ session_id: "s1", cwd: "C:\\nope\\same-dir", hook_event_name: "SessionStart" });
    const b = r.ensure({ session_id: "s2", cwd: "C:\\nope\\same-dir", hook_event_name: "SessionStart" });
    const c = r.ensure({ session_id: "s3", cwd: "C:\\nope\\same-dir", hook_event_name: "SessionStart" });
    expect(a.label).toBe("same-dir");
    expect(b.label).toBe("same-dir 2");
    expect(c.label).toBe("same-dir 3");
  });
});

describe("working-set + pager model", () => {
  function fill(r: SessionRegistry, ids: string[]) {
    for (const id of ids) start(r, id);
  }

  it("fills slots in order, auto-targets first, no pager under slotCount", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e"]);
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.pagerActive()).toBe(false);
    expect(r.targetedSession?.sessionId).toBe("a");
  });

  it("activates the pager at slotCount+1, keeping the first 4 working", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    expect(r.pagerActive()).toBe(true);
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]);
    expect(r.snapshot().overflow).toEqual(["e", "f"]);
    expect(r.bySlot(3)?.sessionId).toBe("d");
  });

  it("floats an overflow session to MRU front on activity; working never reorders", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    r.recordEvent(r.get("f")!, "PostToolUse");
    expect(r.snapshot().overflow).toEqual(["f", "e"]);
    r.recordEvent(r.get("a")!, "PostToolUse"); // working member — no reorder
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]);
  });

  it("surfaces a single waiting overflow session into slot #4", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]); // working [a,b,c,d], overflow [e,f]
    r.setStatus(r.get("e")!, "waiting");
    expect(r.snapshot().working).toEqual(["a", "b", "c", "e"]);
    expect(r.snapshot().overflow).toContain("d");
    expect(r.pagerFlashing()).toBe(false);
  });

  it("flashes the pager when a second overflow session needs attention", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f", "g"]); // working [a,b,c,d], overflow [e,f,g]
    r.setStatus(r.get("e")!, "waiting"); // surfaces e → slot 3
    r.setStatus(r.get("f")!, "waiting"); // slot 3 busy → flash
    expect(r.pagerFlashing()).toBe(true);
    expect(r.snapshot().working).toContain("e"); // e stayed surfaced
    expect(r.snapshot().overflow).toContain("f");
    // Resolving the overflow waiter clears the flash.
    r.setStatus(r.get("f")!, "thinking");
    expect(r.pagerFlashing()).toBe(false);
  });

  it("promoteToFront brings a session to slot #1 and shifts the rest", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    r.promoteToFront("f");
    expect(r.snapshot().working).toEqual(["f", "a", "b", "c"]);
    expect(r.snapshot().overflow).toContain("d");
    expect(r.targetedSession?.sessionId).toBe("f");
  });

  it("moveToSlot inserts before the target: ABCD move A→2 = BCAD", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d"]); // working [a,b,c,d], no pager
    r.moveToSlot("a", 2);
    expect(r.snapshot().working).toEqual(["b", "c", "a", "d"]);
  });

  it("caps tracked sessions at maxSessions, dropping LRU overflow", () => {
    const r = new SessionRegistry(5, 6); // cap at 6
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    start(r, "g"); // 7th → over cap → drop LRU overflow tail
    expect(r.all().length).toBe(6);
  });

  it("retargets and refills working on release of a slotted session", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]); // working [a,b,c,d], overflow [e,f]
    r.release("a");
    // pager deactivates (5 left), working refills from overflow
    expect(r.pagerActive()).toBe(false);
    expect(r.snapshot().working).toEqual(["b", "c", "d", "e", "f"]);
    expect(r.targetedSession?.sessionId).toBe("b");
  });
});
