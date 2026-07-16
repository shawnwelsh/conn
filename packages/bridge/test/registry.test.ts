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

describe("slot management", () => {
  it("claims slots in order and auto-targets the first session", () => {
    const r = new SessionRegistry(5);
    expect(start(r, "a").slot).toBe(0);
    expect(start(r, "b").slot).toBe(1);
    expect(r.targetedSession?.sessionId).toBe("a");
  });

  it("evicts the oldest done session when full", () => {
    const r = new SessionRegistry(2);
    const a = start(r, "a");
    start(r, "b");
    r.setStatus(a, "done");
    const c = start(r, "c");
    expect(c.slot).toBe(0);
    expect(r.get("a")?.slot).toBe(-1); // overflowed
  });

  it("overflows when full with no evictable session, then promotes on release", () => {
    const r = new SessionRegistry(2);
    start(r, "a");
    start(r, "b");
    const c = start(r, "c");
    expect(c.slot).toBe(-1);
    r.release("a");
    expect(r.get("c")?.slot).toBe(0);
  });

  it("retargets on release of the targeted session", () => {
    const r = new SessionRegistry(5);
    start(r, "a");
    start(r, "b");
    r.release("a");
    expect(r.targetedSession?.sessionId).toBe("b");
  });
});
