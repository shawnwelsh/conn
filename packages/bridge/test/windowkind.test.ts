import { describe, expect, it, beforeEach } from "vitest";
import { SessionRegistry } from "../src/registry.js";
import { DeckController } from "../src/controller.js";
import { initialRow1, initialControls, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const flush = () => new Promise((r) => setTimeout(r, 300)); // past the console submit gap

describe("pending-launch binding (windowKind)", () => {
  it("binds a session starting in a launched cwd to console + hwnd", () => {
    const r = new SessionRegistry(5);
    r.registerPendingLaunch({ cwd: "C:\\dev\\myrepo", pid: 4242, hwnd: 777, at: Date.now() });
    const entry = r.ensure({ session_id: "s1", cwd: "c:/dev/myrepo/", hook_event_name: "SessionStart" });
    expect(entry.windowKind).toBe("console");
    expect(entry.hwnd).toBe(777);
    expect(entry.pid).toBe(4242);
  });

  it("ignores stale launches and non-matching cwds", () => {
    const r = new SessionRegistry(5);
    r.registerPendingLaunch({ cwd: "C:\\dev\\old", pid: 1, hwnd: 1, at: Date.now() - 120_000 });
    r.registerPendingLaunch({ cwd: "C:\\dev\\other", pid: 2, hwnd: 2, at: Date.now() });
    const entry = r.ensure({ session_id: "s1", cwd: "C:\\dev\\old", hook_event_name: "SessionStart" });
    expect(entry.windowKind).toBe("desktop");
    expect(entry.hwnd).toBeUndefined();
  });

  it("consumes a launch only once", () => {
    const r = new SessionRegistry(5);
    r.registerPendingLaunch({ cwd: "C:\\dev\\repo", pid: 1, hwnd: 10, at: Date.now() });
    const a = r.ensure({ session_id: "s1", cwd: "C:\\dev\\repo", hook_event_name: "SessionStart" });
    const b = r.ensure({ session_id: "s2", cwd: "C:\\dev\\repo", hook_event_name: "SessionStart" });
    expect(a.windowKind).toBe("console");
    expect(b.windowKind).toBe("desktop");
  });
});

describe("per-kind command dialects", () => {
  const cfg = { slots: 5, desktopJumpSettleMs: 0, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5, cannedCommands: {} } as unknown as DeckConfig;

  class RecordingAdapter implements DeliveryAdapter {
    calls: string[] = [];
    async focus(): Promise<boolean> { this.calls.push("focus"); return true; }
    async sendText(_s: SessionRef, t: string): Promise<boolean> { this.calls.push(`text:${t}`); return true; }
    async sendKey(_s: SessionRef, c: string): Promise<boolean> { this.calls.push(`key:${c}`); return true; }
    async sendSequence(_s: SessionRef, cs: string[]): Promise<boolean> { this.calls.push(`seq:${cs.join("+")}`); return true; }
    async findWindowByPid(): Promise<number | null> { return null; }
    async checkWindow(): Promise<boolean | null> { return null; }
    async dispose(): Promise<void> {}
  }

  let r: SessionRegistry;
  let layer: DeckLayerState;
  let adapter: RecordingAdapter;
  let c: DeckController;

  beforeEach(() => {
    r = new SessionRegistry(5);
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: { mode: "default", page: 0 }, row3Page: 0, controls: initialControls() };
    adapter = new RecordingAdapter();
    c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    c.setCommands({
      all: () => [
        { kind: "builtin", id: "mode" },
        { kind: "builtin", id: "model" },
      ],
      move: () => {},
    });
  });

  it("mode speaks TUI (shift+tab) to console sessions", async () => {
    r.registerPendingLaunch({ cwd: "C:\\dev\\x", pid: 1, hwnd: 5, at: Date.now() });
    r.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    (c as any).row2(0);
    await flush();
    expect(adapter.calls).toEqual(["key:shift+tab"]);
  });

  it("mode speaks picker (ctrl+shift+m + number) to desktop sessions", async () => {
    r.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    (c as any).row2(0);
    await flush();
    expect(adapter.calls).toEqual(["seq:ctrl+shift+m+4"]);
  });

  it("model types /model on console, cycles Ctrl+Shift+I on desktop", async () => {
    r.registerPendingLaunch({ cwd: "C:\\dev\\x", pid: 1, hwnd: 5, at: Date.now() });
    r.ensure({ session_id: "con", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    (c as any).row2(1);
    await flush();
    expect(adapter.calls).toEqual(["text:/model", "key:enter"]);

    adapter.calls = [];
    const desk = r.ensure({ session_id: "desk", cwd: "C:\\dev\\y", hook_event_name: "SessionStart" });
    r.target(desk.sessionId);
    (c as any).row2(1);
    await flush();
    expect(adapter.calls).toEqual(["seq:ctrl+shift+i+1"]);
  });
});
