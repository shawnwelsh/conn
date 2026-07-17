import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandStore, MAX_COMMANDS } from "../src/commands.js";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import { NoopAdapter } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const dir = join(tmpdir(), `claude-deck-commands-${process.pid}`);
const file = join(dir, "commands.json");

beforeEach(() => mkdirSync(dir, { recursive: true }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CommandStore", () => {
  it("creates the default file when missing and parses mixed entries", () => {
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    const entries = store.all();
    expect(entries[0]).toEqual({ kind: "builtin", id: "mode" });
    expect(entries[1]).toEqual({ kind: "builtin", id: "model" });
    expect(entries.some((e) => e.kind === "text" && e.label === "Commit" && e.text === "/save-work")).toBe(true);
  });

  it("caps at 15 entries and survives a broken file", () => {
    writeFileSync(file, JSON.stringify(Array.from({ length: 20 }, (_, i) => `/cmd${i}`)));
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    expect(store.all().length).toBe(MAX_COMMANDS);

    writeFileSync(file, "{not json");
    store.load(); // parse fails → previous lineup kept
    expect(store.all().length).toBe(MAX_COMMANDS);
  });

  it("move persists the new order back to the file (insert-before)", () => {
    writeFileSync(file, JSON.stringify(["mode", "model", "/a", "/b"]));
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    store.move(0, 2); // [model, /a, mode, /b]
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toEqual(["model", "/a", "mode", "/b"]);
  });
});

describe("row-2 command pager + move", () => {
  const cfg = { slots: 5, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5 } as unknown as DeckConfig;

  function setup(entryNames: string[]) {
    writeFileSync(file, JSON.stringify(entryNames));
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    const registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    const layer: DeckLayerState = {
      row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls(),
    };
    const calls: string[] = [];
    const adapter = new NoopAdapter(() => {});
    adapter.focus = async () => { calls.push("focus"); return true; };
    adapter.sendText = async (_s, t) => { calls.push(`text:${t}`); return true; };
    adapter.sendKey = async (_s, k) => { calls.push(`key:${k}`); return true; };
    const controller = new DeckController(registry, layer, adapter, cfg, noopLog, () => {});
    controller.setCommands(store);
    return { store, layer, controller, calls };
  }

  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("key 10 opens the pager when more than 4 entries; tap executes and closes", async () => {
    const { layer, controller, calls } = setup(["/a", "/b", "/c", "/d", "/e", "/f"]);
    (controller as any).row2(4); // pager key
    expect(layer.row2Cmd.mode).toBe("pager");
    (controller as any).row2(4); // next page → page 2 shows /e /f
    expect(layer.row2Cmd.page).toBe(1);
    (controller as any).row2(1); // tap /f → execute + close
    await flush();
    expect(calls).toEqual(["focus", "text:/f", "key:enter"]);
    expect(layer.row2Cmd.mode).toBe("default");
  });

  it("long-press begins a move; drop persists via the store", async () => {
    vi.useFakeTimers();
    const { store, layer, controller } = setup(["/a", "/b", "/c", "/d", "/e"]);
    controller.down(5); // key 6 = entry 0
    vi.advanceTimersByTime(600); // long-press fires
    controller.up(5);
    expect(layer.row2Cmd.mode).toBe("move");
    controller.down(7);
    controller.up(7);
    vi.advanceTimersByTime(350); // resolve the tap (double-tap window)
    expect(layer.row2Cmd.mode).toBe("default");
    expect(store.all().map((e) => (e.kind === "text" ? e.text : e.id))).toEqual(["/b", "/c", "/a", "/d", "/e"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toEqual(["/b", "/c", "/a", "/d", "/e"]);
    vi.useRealTimers();
  });
});
