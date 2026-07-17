import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BindingStore, restoreConsoleBindings } from "../src/bindings.js";
import { SessionRegistry } from "../src/registry.js";
import { NoopAdapter } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const dir = join(tmpdir(), `claude-deck-bindings-${process.pid}`);
const file = join(dir, "console-bindings.json");

beforeEach(() => mkdirSync(dir, { recursive: true }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("BindingStore", () => {
  it("round-trips bindings and upserts by cwd (one console per working tree)", () => {
    const store = new BindingStore(file, noopLog);
    store.upsert({ cwd: "C:\\dev\\wt\\a", pid: 100, at: 1 });
    store.upsert({ cwd: "C:\\dev\\wt\\b", pid: 200, at: 2 });
    store.upsert({ cwd: "c:/dev/wt/a", pid: 111, at: 3 }); // same cwd, different casing/slashes
    const all = store.load();
    expect(all).toHaveLength(2);
    expect(all.find((b) => b.pid === 111)).toBeTruthy();
    expect(all.find((b) => b.pid === 100)).toBeUndefined();
  });

  it("removeByCwd is separator/case-insensitive; load survives a broken file", () => {
    const store = new BindingStore(file, noopLog);
    store.upsert({ cwd: "C:\\dev\\wt\\a", pid: 100, at: 1 });
    store.removeByCwd("c:/DEV/wt/a/");
    expect(store.load()).toHaveLength(0);

    rmSync(file, { force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{not json");
    expect(store.load()).toEqual([]);
  });
});

describe("restoreConsoleBindings (boot)", () => {
  function adapterWithWindows(byPid: Record<number, number>) {
    const adapter = new NoopAdapter(() => {});
    adapter.findWindowByPid = async (pid: number) => byPid[pid] ?? null;
    return adapter;
  }

  it("restores live consoles as bound provisional keys; session hooks adopt in place", async () => {
    const store = new BindingStore(file, noopLog);
    store.upsert({ cwd: "C:\\dev\\wt\\crisp-yak", pid: 500, at: 1 });
    const registry = new SessionRegistry(5);
    await restoreConsoleBindings(store, registry, adapterWithWindows({ 500: 42 }), noopLog);

    const restored = registry.all()[0]!;
    expect(restored.sessionId.startsWith("launching:")).toBe(true);
    expect(restored.windowKind).toBe("console");
    expect(restored.hwnd).toBe(42);
    expect(restored.pid).toBe(500);

    // The session's next hook (no SessionStart fires at interactive launch)
    // adopts the restored key in place — binding and kind survive.
    const adopted = registry.ensure({
      session_id: "real-session",
      cwd: "c:/dev/wt/crisp-yak",
      hook_event_name: "UserPromptSubmit",
    });
    expect(adopted.windowKind).toBe("console");
    expect(adopted.hwnd).toBe(42);
    expect(registry.all()).toHaveLength(1);
    expect(registry.get("real-session")).toBe(adopted);
  });

  it("prunes bindings whose process no longer owns a window", async () => {
    const store = new BindingStore(file, noopLog);
    store.upsert({ cwd: "C:\\dev\\wt\\gone", pid: 900, at: 1 });
    store.upsert({ cwd: "C:\\dev\\wt\\alive", pid: 901, at: 2 });
    const registry = new SessionRegistry(5);
    await restoreConsoleBindings(store, registry, adapterWithWindows({ 901: 7 }), noopLog);

    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]!.cwd).toBe("C:\\dev\\wt\\alive");
    const persisted = store.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.pid).toBe(901);
  });

  it("a dead-window event drops the persisted binding (wired via registry emit)", () => {
    const store = new BindingStore(file, noopLog);
    store.upsert({ cwd: "C:\\dev\\wt\\a", pid: 100, at: 1 });
    const registry = new SessionRegistry(5);
    registry.on("windowDead", (entry: { cwd: string }) => store.removeByCwd(entry.cwd));
    const entry = registry.ensure({ session_id: "s1", cwd: "C:\\dev\\wt\\a", hook_event_name: "UserPromptSubmit" });
    entry.hwnd = 5;
    registry.markWindowDead("s1");
    expect(store.load()).toHaveLength(0);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });
});
