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
  async setWindowState(_s: SessionRef, state: "maximize" | "restore"): Promise<boolean> {
    this.calls.push({ m: "setWindowState", chords: [state] });
    return true;
  }
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

  it("a dictate command types the prefix and opens the mic instead of sending", async () => {
    const stt = {
      status: "ready" as const,
      calls: [] as string[],
      async start() { this.calls.push("start"); this.status = "recording" as never; return true; },
      async stop() { this.calls.push("stop"); this.status = "ready" as never; return "check the leap year path"; },
      async cancel() { this.calls.push("cancel"); },
    };
    const cfgPtt = { ...(cfg as object), ptt: { maxSeconds: 60 } } as DeckConfig;
    const c = new DeckController(registry, layer, delivery, cfgPtt, noopLog, () => {});
    c.setStt(stt as never);
    // NOTE: no trailing space in the entry — commands.json text is trimmed on
    // parse, so one written there never survives. The separator is added at
    // use time instead, which is what the assertion below pins.
    c.setCommands(fakeCommands([{ kind: "text", label: "Subtask", text: "/subtask", dictate: true }]));

    (c as any).row2(0);
    await flush();
    // Prefix typed WITH its separating space, and NO Enter — the argument is
    // still to come. Without the space the speech would land as "/subtaskcheck
    // the leap year path" and Claude Code would see one unknown token.
    expect(delivery.calls).toEqual([{ m: "sendText", chords: ["/subtask "] }]);
    expect(stt.calls).toEqual(["start"]);

    // Send then ships prefix + speech in one press.
    await (c as any).row3(1);
    await flush();
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls.map((x) => x.m)).toEqual(["sendText", "sendText", "sendKey"]);
    expect(delivery.calls[1]!.chords).toEqual(["check the leap year path"]);
    // End to end, the session receives a well-formed command line.
    expect(delivery.calls.slice(0, 2).map((x) => x.chords[0]).join("")).toBe(
      "/subtask check the leap year path",
    );
  });

  it("normalises the dictate separator however the entry was written", async () => {
    // Whether the user wrote "/btw", "/btw " or "/btw   ", exactly one space
    // reaches the session — no missing separator, no double space.
    for (const [written, expected] of [
      ["/btw", "/btw "],
      ["/btw ", "/btw "],
      ["/btw   ", "/btw "],
    ] as const) {
      const stt = {
        status: "ready" as const,
        async start() { this.status = "recording" as never; return true; },
        async stop() { this.status = "ready" as never; return ""; },
        async cancel() {},
      };
      const d = new RecordingAdapter();
      const cfgPtt = { ...(cfg as object), ptt: { maxSeconds: 60 } } as DeckConfig;
      const c = new DeckController(registry, layer, d, cfgPtt, noopLog, () => {});
      c.setStt(stt as never);
      c.setCommands(fakeCommands([{ kind: "text", label: "BTW", text: written, dictate: true }]));
      (c as any).row2(0);
      await flush();
      expect(d.calls[0]!.chords).toEqual([expected]);
    }
  });

  it("globals page 2 holds Resume, Fork and Branch", async () => {
    const c = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
    await (c as any).row3(4); // Page → page 2
    expect(layer.row3Page).toBe(1);

    await (c as any).row3(1); // Fork
    await flush();
    expect(delivery.calls.map((x) => x.chords[0])).toEqual(["/fork", "enter"]);

    delivery.calls = [];
    await (c as any).row3(2); // Branch
    await flush();
    expect(delivery.calls.map((x) => x.chords[0])).toEqual(["/branch", "enter"]);

    await (c as any).row3(4); // Page → back
    expect(layer.row3Page).toBe(0);
  });

  it("Fork and Branch refuse to type at a prompt", async () => {
    const c = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
    c.setPromptProbe(() => true);
    layer.row3Page = 1;
    await (c as any).row3(1);
    await (c as any).row3(2);
    await flush();
    expect(delivery.calls).toEqual([]);
    layer.row3Page = 0;
  });

  it("Resume runs `claude --resume` in place — no worktree", async () => {
    // Resuming picks up work that already exists, so a fresh worktree would
    // be the wrong place to land it.
    const cfgResume = { ...(cfg as object), newSessionCommand: "claude" } as DeckConfig;
    const c = new DeckController(registry, layer, delivery, cfgResume, noopLog, () => {});
    const calls: Array<{ cwd: string; opts?: unknown }> = [];
    c.setLauncher({ launch: async (cwd: string, opts?: unknown) => { calls.push({ cwd, opts }); return true; } } as never);
    layer.row3Page = 1; // Resume lives on globals page 2
    await (c as any).row3(0);
    expect(calls).toEqual([{ cwd: "C:\\dev\\x", opts: { command: "claude --resume", worktree: false } }]);
  });

  it("Resume respects the in-flight guard, like New", async () => {
    let release!: (v: boolean) => void;
    const launches: string[] = [];
    controller.setLauncher({
      launch: (cwd: string) => {
        launches.push(cwd);
        return new Promise<boolean>((r) => (release = r));
      },
    } as never);
    layer.row3Page = 1;
    const first = (controller as any).row3(0);
    expect(layer.launching).toBe(true);
    await (controller as any).row3(0); // second press while spawning → ignored
    expect(launches).toHaveLength(1);
    release(true);
    await first;
    expect(layer.launching).toBe(false);
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

  it("a key-sequence command spaces its chords (Accept Next = tab, then enter)", async () => {
    // Tab accepts Claude Code's suggested next prompt; the Enter must land
    // AFTER that has rendered, or it submits an input the Tab hadn't filled.
    vi.useFakeTimers();
    const cfgDelay = { ...(cfg as object), desktopSubmitDelayMs: 250 } as DeckConfig;
    const c = new DeckController(registry, layer, delivery, cfgDelay, noopLog, () => {});
    c.setCommands(fakeCommands([{ kind: "keys", label: "Accept Next", keys: ["tab", "enter"] }]));
    (c as any).row2(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery.calls.map((c2) => c2.chords[0])).toEqual(["tab"]); // enter still pending
    await vi.advanceTimersByTimeAsync(250);
    expect(delivery.calls.map((c2) => c2.chords[0])).toEqual(["tab", "enter"]);
    vi.useRealTimers();
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

describe("plan approval answers the console menu by keystroke, not the hook", () => {
  function setup(windowKind: "console" | "desktop") {
    const registry = new SessionRegistry(5);
    const s = registry.ensure({ session_id: "plan1", cwd: "C:\dev\p", hook_event_name: "SessionStart" });
    s.windowKind = windowKind;
    const layer: DeckLayerState = {
      row1: initialRow1(),
      row2: "permission",
      row2Cmd: initialRow2Cmd(),
      row3Page: 0,
      permission: { sessionId: "plan1", toolName: "ExitPlanMode", summary: "{}" },
      controls: initialControls(),
    };
    const delivery = new RecordingAdapter();
    const hookCalls: string[] = [];
    const controller = new DeckController(registry, layer, delivery, cfg, noopLog, () => {}, {
      onPermissionKey: () => hookCalls.push("permKey"),
      onPermissionDefer: () => hookCalls.push("defer"),
    });
    return { registry, layer, delivery, controller, hookCalls };
  }

  it("Approve plan on a console sends '1' + Enter and releases the hook", async () => {
    const { controller, delivery, hookCalls } = setup("console");
    (controller as any).row2(0);
    await flush();
    // Focus, then the auto-mode digit, then Enter — the question-layer path.
    expect(delivery.calls).toEqual([
      { m: "focus", chords: [] },
      { m: "sendKey", chords: ["1"] },
      { m: "sendKey", chords: ["enter"] },
    ]);
    expect(hookCalls).toEqual(["defer"]); // released the panel, never used the hook decision
  });

  it("Keep planning on a console sends Esc, not a hook deny", async () => {
    const { controller, delivery, hookCalls } = setup("console");
    (controller as any).row2(2);
    await flush();
    expect(delivery.calls).toEqual([
      { m: "focus", chords: [] },
      { m: "sendKey", chords: ["escape"] },
    ]);
    expect(hookCalls).toEqual(["defer"]);
  });

  it("a DESKTOP plan still goes through the hook (no keystroke path there)", async () => {
    const { controller, delivery, hookCalls } = setup("desktop");
    (controller as any).row2(0);
    await flush();
    expect(delivery.calls).toEqual([]); // nothing typed
    expect(hookCalls).toEqual(["permKey"]); // ordinary hook decision
  });

  it("an ordinary (non-plan) permission still goes through the hook", async () => {
    const { layer, controller, delivery, hookCalls } = setup("console");
    layer.permission = { sessionId: "plan1", toolName: "Bash", summary: "ls" };
    (controller as any).row2(0);
    await flush();
    expect(delivery.calls).toEqual([]);
    expect(hookCalls).toEqual(["permKey"]);
  });
});

describe("double-tap-hold a session focuses and toggles full-screen", () => {
  function setup() {
    const registry = new SessionRegistry(5);
    const s = registry.ensure({ session_id: "m1", cwd: "C:\dev\m", hook_event_name: "SessionStart" });
    s.windowKind = "console";
    const layer: DeckLayerState = {
      row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls(),
    };
    const delivery = new RecordingAdapter();
    const controller = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
    return { registry, controller, delivery };
  }

  it("first double-long maximises, second restores — same key", async () => {
    const { controller, delivery } = setup();
    (controller as any).row1(0, "doubleLong");
    await flush();
    expect(delivery.calls).toEqual([
      { m: "focus", chords: [] },
      { m: "setWindowState", chords: ["maximize"] },
    ]);
    delivery.calls.length = 0;
    (controller as any).row1(0, "doubleLong");
    await flush();
    expect(delivery.calls).toEqual([
      { m: "focus", chords: [] },
      { m: "setWindowState", chords: ["restore"] },
    ]);
  });

  it("targets the session too, like the other row-1 gestures", async () => {
    const { registry, controller } = setup();
    registry.ensure({ session_id: "m2", cwd: "C:\dev\m2", hook_event_name: "SessionStart" });
    registry.target("m2");
    (controller as any).row1(0, "doubleLong"); // slot 0 = m1
    await flush();
    expect(registry.targetedSession?.sessionId).toBe("m1");
  });
});
