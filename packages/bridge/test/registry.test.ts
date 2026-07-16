import { describe, expect, it } from "vitest";
import { SessionRegistry, deriveLabel } from "../src/registry.js";

function start(registry: SessionRegistry, id: string, cwd = `C:\\dev\\${id}`) {
  return registry.ensure({ session_id: id, cwd, hook_event_name: "SessionStart" });
}

describe("deriveLabel", () => {
  it("uses the cwd leaf directory", () => {
    expect(deriveLabel("C:\\dev\\revops-platform")).toBe("revops-platform");
    expect(deriveLabel("C:\\dev\\claude-deck\\")).toBe("claude-deck");
    expect(deriveLabel("/home/user/proj")).toBe("proj");
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
