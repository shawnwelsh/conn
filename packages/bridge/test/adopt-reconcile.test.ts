import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/registry.js";

// The bug this covers: a restored provisional (launching:*) key sat as a
// phantom while the real interactive session — which fires no SessionStart
// hook — couldn't surface (adoptTerminals saw the tree "covered") and later
// landed as a "name 2" duplicate. adoptProvisionalTerminal reconciles the two.
describe("adoptProvisionalTerminal — interactive adopt reconciles the placeholder key", () => {
  const wt = (name: string) => `C:\\dev\\repo\\.claude\\worktrees\\${name}`;

  it("swaps the provisional's id to the real session, binds pid + name, leaves NO duplicate", () => {
    const r = new SessionRegistry(5);
    const cwd = wt("deft-badger");
    const prov = r.addProvisionalAt(cwd);
    expect(prov.sessionId).toMatch(/^launching:/);

    const adopted = r.adoptProvisionalTerminal({
      sessionId: "real-abc",
      cwd,
      pid: 4242,
      name: "MSP Products",
      status: "thinking",
    });

    expect(adopted).not.toBeNull();
    expect(adopted!.sessionId).toBe("real-abc");
    expect(adopted!.pid).toBe(4242);
    expect(adopted!.label).toBe("MSP Products");
    expect(adopted!.windowKind).toBe("console");
    expect(adopted!.status).toBe("thinking");
    // Exactly one entry — the launching:* phantom is gone, no "MSP Products 2".
    expect(r.all().length).toBe(1);
    expect(r.all().some((s) => s.sessionId.startsWith("launching:"))).toBe(false);
    expect(r.get("real-abc")).toBeDefined();
  });

  it("targeting and slot follow the identity swap", () => {
    const r = new SessionRegistry(5);
    const cwd = wt("keen-panda");
    const prov = r.addProvisionalAt(cwd); // addProvisionalAt targets the new key
    const slot = prov.slot;
    expect(r.targetedSession?.sessionId).toBe(prov.sessionId);

    r.adoptProvisionalTerminal({ sessionId: "real-xyz", cwd, pid: 9, name: "click wrap website" });

    expect(r.targetedSession?.sessionId).toBe("real-xyz");
    expect(r.get("real-xyz")?.slot).toBe(slot);
  });

  it("matches a session that wandered into a subdirectory of the launch cwd", () => {
    const r = new SessionRegistry(5);
    const cwd = wt("spry-otter");
    r.addProvisionalAt(cwd);
    const adopted = r.adoptProvisionalTerminal({ sessionId: "s2", cwd: `${cwd}\\scratch\\thing`, pid: 7 });
    expect(adopted?.sessionId).toBe("s2");
  });

  it("returns null when no provisional covers the cwd — caller then surfaces a fresh key", () => {
    const r = new SessionRegistry(5);
    r.addProvisionalAt(wt("other"));
    const res = r.adoptProvisionalTerminal({ sessionId: "s", cwd: wt("unrelated"), pid: 1 });
    expect(res).toBeNull();
  });

  it("does not disturb an already-real session in the same tree (never re-swaps)", () => {
    const r = new SessionRegistry(5);
    const cwd = wt("vivid-jackal");
    // A real session already occupies this tree (no provisional present).
    r.ensure({ session_id: "already-real", cwd, hook_event_name: "SessionStart" });
    const res = r.adoptProvisionalTerminal({ sessionId: "other-real", cwd, pid: 3 });
    expect(res).toBeNull(); // nothing to reconcile → caller falls through to the covered/skip rule
    expect(r.get("already-real")).toBeDefined();
    expect(r.get("other-real")).toBeUndefined();
  });
});
