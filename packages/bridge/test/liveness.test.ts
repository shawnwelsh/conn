import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRegistry } from "../src/registry.js";
import { livenessSweep, cwdVanished } from "../src/liveness.js";
import { NoopAdapter, type DeliveryAdapter } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

function seedConsole(r: SessionRegistry, id: string, n: number) {
  // pid and hwnd share the number — liveness keys on the pid (primary signal).
  r.registerPendingLaunch({ cwd: `C:\\dev\\${id}`, pid: n, hwnd: n, at: Date.now() });
  return r.ensure({ session_id: id, cwd: `C:\\dev\\${id}`, hook_event_name: "SessionStart" });
}

function adapterWhere(liveness: Record<number, boolean | null>): DeliveryAdapter {
  const a = new NoopAdapter(() => {});
  a.checkPid = async (pid: number) => liveness[pid] ?? null;
  a.checkWindow = async (hwnd?: number) => liveness[hwnd as number] ?? null;
  return a as DeliveryAdapter;
}

describe("dead-window lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("marks dead, demotes to the END of the overflow line, retargets", async () => {
    const r = new SessionRegistry(5);
    const ids = ["a", "b", "c", "d", "e", "f"];
    ids.forEach((id, i) => seedConsole(r, id, 100 + i));
    // working [a,b,c,d], overflow [e,f] (MRU: f newer... order per ensure: e,f pushed -> overflow [f,e]? place() unshifts -> [f,e])
    const before = r.snapshot();
    expect(before.working).toEqual(["a", "b", "c", "d"]);

    // a's window (hwnd 100) dies; everything else alive.
    await livenessSweep(r, adapterWhere({ 100: false, 101: true, 102: true, 103: true, 104: true, 105: true }), 3 * 3_600_000, noopLog);

    const s = r.snapshot();
    expect(r.get("a")?.windowDead).toBe(true);
    expect(s.working).not.toContain("a");
    expect(s.overflow.at(-1)).toBe("a"); // end of the line
    expect(s.working.length).toBe(4); // refilled from live overflow
    expect(r.targetedSession?.sessionId).not.toBe("a");
  });

  it("dead sessions never re-promote into working", async () => {
    const r = new SessionRegistry(5);
    seedConsole(r, "a", 100);
    seedConsole(r, "b", 101);
    await livenessSweep(r, adapterWhere({ 100: false, 101: true }), 3 * 3_600_000, noopLog);
    // Slot freed by a's demotion must not be refilled by dead a.
    expect(r.snapshot().working).toEqual(["b"]);
    expect(r.snapshot().overflow).toEqual(["a"]);
    r.release("b");
    expect(r.snapshot().working).toEqual([]); // still not promoted
  });

  it("unknown liveness (null) never skulls a session", async () => {
    const r = new SessionRegistry(5);
    seedConsole(r, "a", 100);
    await livenessSweep(r, adapterWhere({}), 3 * 3_600_000, noopLog);
    expect(r.get("a")?.windowDead).toBeFalsy();
  });

  it("sweeps dead sessions after the TTL", async () => {
    vi.setSystemTime(new Date("2026-07-17T12:00:00Z"));
    const r = new SessionRegistry(5);
    seedConsole(r, "a", 100);
    await livenessSweep(r, adapterWhere({ 100: false }), 3 * 3_600_000, noopLog);
    expect(r.get("a")?.windowDead).toBe(true);

    vi.setSystemTime(new Date("2026-07-17T14:59:00Z")); // 2h59 later — still there
    await livenessSweep(r, adapterWhere({}), 3 * 3_600_000, noopLog);
    expect(r.get("a")).toBeDefined();

    vi.setSystemTime(new Date("2026-07-17T15:01:00Z")); // past 3h — gone
    await livenessSweep(r, adapterWhere({}), 3 * 3_600_000, noopLog);
    expect(r.get("a")).toBeUndefined();
  });
});

// Desktop sessions carry neither pid nor hwnd, so nothing in this sweep ever
// examined them: a key whose worktree had been cleaned up sat looking live
// indefinitely. A vanished working directory is that missing signal — and it
// is deliberately the weakest one.
describe("vanished working directory", () => {
  const fixture = join(tmpdir(), `conn-liveness-cwd-${process.pid}`);
  const repo = join(fixture, "repo");
  const gone = join(repo, ".claude", "worktrees", "deleted-one");

  beforeAll(() => mkdirSync(join(repo, ".git"), { recursive: true }));
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  const desktop = (r: SessionRegistry, id: string, cwd: string) =>
    r.ensure({ session_id: id, cwd, hook_event_name: "SessionStart" });

  it("recognises a deleted worktree, but not an unreachable volume", () => {
    expect(cwdVanished(gone)).toBe(true); // repo still there, this tree is not
    expect(cwdVanished(repo)).toBe(false); // exists
    expect(cwdVanished(undefined)).toBe(false);
    // Whole tree unreachable (unmounted drive / OneDrive blip): refuse to judge.
    expect(cwdVanished(join(fixture, "nope", "deeper", "still"))).toBe(false);
  });

  it("skulls a desktop session whose worktree was deleted", async () => {
    const r = new SessionRegistry(5);
    const s = desktop(r, "stale", gone);
    await livenessSweep(r, new NoopAdapter(() => {}) as DeliveryAdapter, 3_600_000, noopLog);
    expect(s.windowDead).toBe(true);
  });

  it("NEVER skulls one Claude Code still has a process for", async () => {
    // The directory is gone, but the conversation is open — the key is real.
    const r = new SessionRegistry(5);
    const s = desktop(r, "stale", gone);
    await livenessSweep(r, new NoopAdapter(() => {}) as DeliveryAdapter, 3_600_000, noopLog, new Set(["stale"]));
    expect(s.windowDead).toBeFalsy();
  });

  it("NEVER skulls a BOUND console over a missing directory", async () => {
    // A console survives its directory being removed — you can still type in
    // it — and an unknown liveness answer must not combine with a missing
    // folder to kill it either. Bound sessions are judged by their process.
    for (const liveness of [true, null] as const) {
      const r = new SessionRegistry(5);
      r.registerPendingLaunch({ cwd: gone, pid: 4242, hwnd: 0, at: Date.now() });
      const s = r.ensure({ session_id: "live", cwd: gone, hook_event_name: "SessionStart" });
      expect(s.pid).toBe(4242);
      await livenessSweep(r, adapterWhere({ 4242: liveness }), 3_600_000, noopLog);
      expect(s.windowDead).toBeFalsy();
    }
  });

  it("leaves a session whose directory is perfectly fine alone", async () => {
    const r = new SessionRegistry(5);
    const s = desktop(r, "ok", repo);
    await livenessSweep(r, new NoopAdapter(() => {}) as DeliveryAdapter, 3_600_000, noopLog);
    expect(s.windowDead).toBeFalsy();
  });
});
