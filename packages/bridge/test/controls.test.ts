import { describe, expect, it, beforeEach, vi } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";
import type { CommandEntry, CommandSource } from "../src/commands.js";

const cfg = { slots: 5, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5 } as unknown as DeckConfig;
const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const flush = () => new Promise((r) => setTimeout(r, 300)); // past the console submit gap

class RecordingAdapter implements DeliveryAdapter {
  calls: Array<{ m: string; chords: string[] }> = [];
  async focus(): Promise<boolean> { this.calls.push({ m: "focus", chords: [] }); return true; }
  async sendText(_s: SessionRef, t: string): Promise<boolean> {
    this.calls.push({ m: "sendText", chords: [t] });
    return true;
  }
  async sendKey(_s: SessionRef, chord: string): Promise<boolean> {
    this.calls.push({ m: "sendKey", chords: [chord] });
    return true;
  }
  async sendSequence(_s: SessionRef, chords: string[]): Promise<boolean> {
    this.calls.push({ m: "sendSequence", chords });
    return true;
  }
  async findWindowByPid(): Promise<number | null> { return null; }
  async checkWindow(): Promise<boolean | null> { return null; }
  async dispose(): Promise<void> {}
}

function fakeCommands(entries: CommandEntry[]): CommandSource & { entries: CommandEntry[] } {
  return {
    entries,
    all() { return this.entries; },
    move(from: number, to: number) {
      const [e] = this.entries.splice(from, 1);
      this.entries.splice(Math.min(to, this.entries.length), 0, e!);
    },
  };
}

describe("mode/model builtin commands (blind toggles)", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let delivery: RecordingAdapter;
  let controller: DeckController;

  beforeEach(() => {
    registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls() };
    delivery = new RecordingAdapter();
    controller = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
    controller.setCommands(fakeCommands([
      { kind: "builtin", id: "mode" },
      { kind: "builtin", id: "model" },
      { kind: "text", label: "/compact", text: "/compact" },
    ]));
  });

  it("mode alternates Ctrl+Shift+M 4 (plan) then 3 (auto) on desktop sessions", async () => {
    (controller as any).row2(0);
    await flush();
    expect(delivery.calls.at(-1)).toEqual({ m: "sendSequence", chords: ["ctrl+shift+m", "4"] });
    expect(layer.controls.planNext).toBe("auto");

    (controller as any).row2(0);
    await flush();
    expect(delivery.calls.at(-1)).toEqual({ m: "sendSequence", chords: ["ctrl+shift+m", "3"] });
    expect(layer.controls.planNext).toBe("plan");
  });

  it("model cycles Ctrl+Shift+I 1→2→3→4→1 on desktop sessions", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      (controller as any).row2(1);
      await flush();
      seen.push(delivery.calls.at(-1)!.chords[1]!);
    }
    expect(seen).toEqual(["1", "2", "3", "4", "1"]);
  });

  it("text commands deliver focus-free as type → Enter", async () => {
    (controller as any).row2(2);
    await flush();
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText", "sendKey"]);
    expect(delivery.calls[0]!.chords).toEqual(["/compact"]);
    expect(delivery.calls[1]!.chords).toEqual(["enter"]);
  });
});

describe("row 3 globals", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let delivery: RecordingAdapter;
  let controller: DeckController;

  beforeEach(() => {
    registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls() };
    delivery = new RecordingAdapter();
    controller = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
  });

  it("Send=Enter, Esc=escape on page 0", async () => {
    await (controller as any).row3(1);
    await (controller as any).row3(2);
    expect(delivery.calls.map((c) => c.chords[0])).toEqual(["enter", "escape"]);
  });

  it("Page does nothing while globals page 2 is empty", async () => {
    // Mode(menu) and Rename moved to the session row, so there's nowhere to
    // page to — the key renders blank and the press is inert.
    await (controller as any).row3(4);
    expect(layer.row3Page).toBe(0);
  });

  it("modemenu is a session-row command, desktop dialect only", async () => {
    controller.setCommands(fakeCommands([{ kind: "builtin", id: "modemenu" }]));
    (controller as any).row2(0);
    await flush();
    expect(delivery.calls.at(-1)).toEqual({ m: "sendKey", chords: ["ctrl+shift+m"] });

    // A console session has no picker chord — the press is a no-op.
    const r2 = new SessionRegistry(5);
    r2.registerPendingLaunch({ cwd: "C:\\dev\\con", pid: 1, hwnd: 5, at: Date.now() });
    r2.ensure({ session_id: "con", cwd: "C:\\dev\\con", hook_event_name: "SessionStart" });
    const c2 = new DeckController(r2, layer, delivery, cfg, noopLog, () => {});
    c2.setCommands(fakeCommands([{ kind: "builtin", id: "modemenu" }]));
    delivery.calls = [];
    (c2 as any).row2(0);
    await flush();
    expect(delivery.calls).toEqual([]);
  });

  it("Mode(menu) no-ops for console sessions — the TUI has no picker chord", async () => {
    registry.registerPendingLaunch({ cwd: "C:\\dev\\con", pid: 9, hwnd: 77, at: Date.now() });
    const con = registry.ensure({ session_id: "con", cwd: "C:\\dev\\con", hook_event_name: "SessionStart" });
    registry.target(con.sessionId);
    await (controller as any).row3(4); // → globals page
    await (controller as any).row3(0); // Mode(menu) slot — hidden for consoles
    expect(delivery.calls).toEqual([]);
  });

  it("New works with NO targeted session via newSessionDir (global key)", async () => {
    const emptyRegistry = new SessionRegistry(5); // no sessions at all
    const cfgWithDir = { ...(cfg as object), newSessionDir: "C:\\dev\\mainrepo" } as DeckConfig;
    const c2 = new DeckController(emptyRegistry, layer, delivery, cfgWithDir, noopLog, () => {});
    const launches: string[] = [];
    c2.setLauncher({ launch: async (cwd: string) => { launches.push(cwd); return true; } } as never);
    await (c2 as any).row3(3);
    expect(launches).toEqual(["C:\\dev\\mainrepo"]);
  });

  it("extraEnter confirms a prompt it can SEE (e.g. /remote-control)", async () => {
    controller.setCommands(fakeCommands([
      { kind: "text", label: "Remote", text: "/remote-control", extraEnter: true },
    ]));
    let prompted = false; // the confirm appears shortly after the submit
    controller.setPromptProbe(() => prompted);
    setTimeout(() => (prompted = true), 100);
    (controller as any).row2(0);
    await new Promise((r) => setTimeout(r, 600));
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText", "sendKey", "sendKey"]);
    expect(delivery.calls[0]!.chords).toEqual(["/remote-control"]);
    expect(delivery.calls[2]!.chords).toEqual(["enter"]);
  });

  it("extraEnter presses NOTHING when no prompt appears", async () => {
    controller.setCommands(fakeCommands([
      { kind: "text", label: "Remote", text: "/remote-control", extraEnter: true },
    ]));
    controller.setPromptProbe(() => false); // nothing to confirm
    (controller as any).row2(0);
    await new Promise((r) => setTimeout(r, 2400));
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText", "sendKey"]); // submit only
  });

  it("extraEnter presses NOTHING when the session state is unknown", async () => {
    controller.setCommands(fakeCommands([
      { kind: "text", label: "Remote", text: "/remote-control", extraEnter: true },
    ]));
    controller.setPromptProbe(() => null); // can't tell → never press blind
    (controller as any).row2(0);
    await new Promise((r) => setTimeout(r, 2400));
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText", "sendKey"]);
  });

  it("refuses ANY command while the session sits at a prompt", async () => {
    // The incident: a pending plan-mode question meant the command's Enter
    // accepted it, exiting plan mode and starting an unread build.
    controller.setPromptProbe(() => true);
    controller.setCommands(fakeCommands([
      { kind: "text", label: "Remote", text: "/remote-control", extraEnter: true },
      { kind: "builtin", id: "mode" },
    ]));
    (controller as any).row2(0);
    (controller as any).row2(1);
    await flush();
    expect(delivery.calls).toEqual([]); // not one keystroke
  });

  it("desktop text commands wait desktopSubmitDelayMs before Enter; consoles don't", async () => {
    vi.useFakeTimers();
    const cfgDelay = { ...(cfg as object), desktopSubmitDelayMs: 250 } as DeckConfig;
    const lineup = fakeCommands([{ kind: "text", label: "/status", text: "/status" }]);

    // Desktop session: Enter must lag the typed text by the settle delay —
    // an instant Enter races the Electron input and is swallowed.
    const c1 = new DeckController(registry, layer, delivery, cfgDelay, noopLog, () => {});
    c1.setCommands(lineup);
    (c1 as any).row2(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText"]); // Enter still pending
    await vi.advanceTimersByTimeAsync(250);
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText", "sendKey"]);

    // Console session: a shorter gap, but never zero — a long dictation is
    // still draining when an instant Enter lands, and gets absorbed.
    delivery.calls = [];
    const r2 = new SessionRegistry(5);
    r2.registerPendingLaunch({ cwd: "C:\\dev\\con", pid: 9, hwnd: 77, at: Date.now() });
    r2.ensure({ session_id: "con", cwd: "C:\\dev\\con", hook_event_name: "SessionStart" });
    const c2 = new DeckController(r2, layer, delivery, cfgDelay, noopLog, () => {});
    c2.setCommands(lineup);
    (c2 as any).row2(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText"]); // Enter still pending
    await vi.advanceTimersByTimeAsync(200);
    expect(delivery.calls.map((c) => c.m)).toEqual(["sendText", "sendKey"]);
    vi.useRealTimers();
  });

  it("New sets the launching flag during flight and ignores double-presses", async () => {
    let resolveLaunch!: (v: boolean) => void;
    const launches: string[] = [];
    controller.setLauncher({
      launch: (cwd: string) => {
        launches.push(cwd);
        return new Promise<boolean>((r) => (resolveLaunch = r));
      },
    } as never);
    const first = (controller as any).row3(3);
    expect(layer.launching).toBe(true);
    await (controller as any).row3(3); // in-flight → ignored
    expect(launches.length).toBe(1);
    resolveLaunch(true);
    await first;
    expect(layer.launching).toBe(false);
  });
});
