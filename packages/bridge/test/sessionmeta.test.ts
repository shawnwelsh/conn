import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPromptStatuses } from "../src/sessionMeta.js";

/** A dead pid: far above the Windows/Linux pid ranges, so it can't collide
 * with a real process on the machine running the tests. */
const DEAD_PID = 0x7fffffff;

describe("readPromptStatuses (prompts no hook reports)", () => {
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
    expect(readPromptStatuses(dir).get("desk")).toBe("waiting");
  });

  it("includes terminal sessions too", () => {
    write("a", { sessionId: "cli1", pid: process.pid, entrypoint: "cli", status: "waiting", updatedAt: 5 });
    expect(readPromptStatuses(dir).get("cli1")).toBe("waiting");
  });

  it("reports the NOT-waiting statuses too, so a key can be brought back down", () => {
    // Returning only the waiting ids made promotion one-way, and keys that had
    // been at a prompt kept breathing long after it was answered: a quiet
    // session sends no hooks, so nothing else was ever going to clear them.
    write("a", { sessionId: "idle", pid: process.pid, status: "idle", updatedAt: 5 });
    write("b", { sessionId: "busy", pid: process.pid, status: "busy", updatedAt: 5 });
    const s = readPromptStatuses(dir);
    expect(s.get("idle")).toBe("idle");
    expect(s.get("busy")).toBe("busy");
  });

  it("takes the freshest record when a session has several", () => {
    // One session can hold records under several pids; an older one saying
    // "waiting" must not outvote the current one.
    write("old", { sessionId: "s", pid: process.pid, status: "waiting", updatedAt: 1 });
    write("new", { sessionId: "s", pid: process.pid, status: "idle", updatedAt: 9 });
    expect(readPromptStatuses(dir).get("s")).toBe("idle");

    write("newer", { sessionId: "s", pid: process.pid, status: "waiting", statusUpdatedAt: 20 });
    expect(readPromptStatuses(dir).get("s")).toBe("waiting");
  });

  it("ignores records that carry no status at all", () => {
    // Live observation: desktop-app records often have an empty status. Absence
    // is not evidence of "not waiting" — treating it as such would let a silent
    // record cancel a live one's prompt.
    write("a", { sessionId: "s", pid: process.pid, entrypoint: "claude-desktop", updatedAt: 99 });
    write("b", { sessionId: "s", pid: process.pid, status: "waiting", updatedAt: 5 });
    expect(readPromptStatuses(dir).get("s")).toBe("waiting");
  });

  it("ignores records whose process is gone — a stale file can't pin a key forever", () => {
    // Nothing would ever clear it: a dead session generates no activity.
    write("a", { sessionId: "ghost", pid: DEAD_PID, status: "waiting", updatedAt: 5 });
    expect(readPromptStatuses(dir).has("ghost")).toBe(false);
  });

  it("survives an unreadable directory and malformed files", () => {
    expect(readPromptStatuses(join(dir, "nope")).size).toBe(0);
    writeFileSync(join(dir, "broken.json"), "{not json");
    write("ok", { sessionId: "s", pid: process.pid, status: "waiting", updatedAt: 1 });
    expect(readPromptStatuses(dir).get("s")).toBe("waiting");
  });
});
