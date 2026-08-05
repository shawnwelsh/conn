import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWaitingSessionIds } from "../src/sessionMeta.js";

/** A dead pid: far above the Windows/Linux pid ranges, so it can't collide
 * with a real process on the machine running the tests. */
const DEAD_PID = 0x7fffffff;

describe("readWaitingSessionIds (prompts no hook reports)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conn-meta-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (file: string, rec: Record<string, unknown>) =>
    writeFileSync(join(dir, `${file}.json`), JSON.stringify(rec));

  it("includes a DESKTOP-app session — the whole point of not reusing the cli filter", () => {
    // readCliSessions drops these because DELIVERY needs a console pid. Being
    // stuck is worth showing wherever the session lives, so this must not
    // inherit that filter.
    write("a", { sessionId: "desk", pid: process.pid, entrypoint: "claude-desktop", status: "waiting", updatedAt: 5 });
    expect(readWaitingSessionIds(dir)).toEqual(new Set(["desk"]));
  });

  it("includes terminal sessions too", () => {
    write("a", { sessionId: "cli1", pid: process.pid, entrypoint: "cli", status: "waiting", updatedAt: 5 });
    expect(readWaitingSessionIds(dir).has("cli1")).toBe(true);
  });

  it("ignores sessions that aren't blocked — idle at the prompt must not light up", () => {
    // Verified against the live machine: a console simply sitting at its input
    // reports "idle", so this is what keeps the deck from breathing constantly.
    write("a", { sessionId: "idle", pid: process.pid, entrypoint: "cli", status: "idle", updatedAt: 5 });
    write("b", { sessionId: "busy", pid: process.pid, entrypoint: "cli", status: "busy", updatedAt: 5 });
    expect(readWaitingSessionIds(dir).size).toBe(0);
  });

  it("takes the freshest record when a session has several", () => {
    // One session can hold records under several pids; an older one saying
    // "waiting" must not outvote the current one.
    write("old", { sessionId: "s", pid: process.pid, status: "waiting", updatedAt: 1 });
    write("new", { sessionId: "s", pid: process.pid, status: "idle", updatedAt: 9 });
    expect(readWaitingSessionIds(dir).has("s")).toBe(false);

    write("newer", { sessionId: "s", pid: process.pid, status: "waiting", statusUpdatedAt: 20 });
    expect(readWaitingSessionIds(dir).has("s")).toBe(true);
  });

  it("ignores records whose process is gone — a stale file can't pin a key forever", () => {
    // Nothing would ever clear it: a dead session generates no activity.
    write("a", { sessionId: "ghost", pid: DEAD_PID, status: "waiting", updatedAt: 5 });
    expect(readWaitingSessionIds(dir).has("ghost")).toBe(false);
  });

  it("survives an unreadable directory and malformed files", () => {
    expect(readWaitingSessionIds(join(dir, "nope"))).toEqual(new Set());
    writeFileSync(join(dir, "broken.json"), "{not json");
    write("ok", { sessionId: "s", pid: process.pid, status: "waiting", updatedAt: 1 });
    expect(readWaitingSessionIds(dir)).toEqual(new Set(["s"]));
  });
});
