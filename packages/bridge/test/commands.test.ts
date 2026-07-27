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
const dir = join(tmpdir(), `conn-commands-${process.pid}`);
const file = join(dir, "commands.json");

beforeEach(() => mkdirSync(dir, { recursive: true }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CommandStore", () => {
  it("creates the default file when missing and parses mixed entries", () => {
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    const entries = store.all();
    // The default lineup mixes all three entry kinds — a keys chord, builtins,
    // and a text/slash command — so this also exercises every parse branch.
    expect(entries[0]).toEqual({ kind: "keys", label: "Accept Next", keys: ["tab", "enter"] });
    expect(entries.some((e) => e.kind === "builtin" && e.id === "mode")).toBe(true);
    expect(entries.some((e) => e.kind === "builtin" && e.id === "model")).toBe(true);
    expect(entries.some((e) => e.kind === "text" && e.label === "Remote" && e.text === "/remote-control" && e.extraEnter === true)).toBe(true);
  });

  it("caps a runaway file and survives a broken one", () => {
    writeFileSync(file, JSON.stringify(Array.from({ length: MAX_COMMANDS + 20 }, (_, i) => `/cmd${i}`)));
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    expect(store.all().length).toBe(MAX_COMMANDS);

    writeFileSync(file, "{not json");
    store.load(); // parse fails → previous lineup kept
    expect(store.all().length).toBe(MAX_COMMANDS);
  });

  it("round-trips extraEnter for commands that open a confirm", () => {
    writeFileSync(file, JSON.stringify([{ label: "Remote", text: "/remote-control", extraEnter: true }, "/status"]));
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    expect(store.all()[0]).toEqual({ kind: "text", label: "Remote", text: "/remote-control", extraEnter: true });

    store.move(1, 0); // any persist must not drop the flag
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toContainEqual({ label: "Remote", text: "/remote-control", extraEnter: true });
  });

  it("parses and round-trips a key-sequence entry", () => {
    writeFileSync(file, JSON.stringify([{ label: "Accept Next", keys: ["tab", "enter"] }, "/status"]));
    const store = new CommandStore(file, noopLog, () => {});
    store.load();
    expect(store.all()[0]).toEqual({ kind: "keys", label: "Accept Next", keys: ["tab", "enter"] });

    store.move(1, 0);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toContainEqual({ label: "Accept Next", keys: ["tab", "enter"] });
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
  const cfg = { slots: 5, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5, cmdPagerRevertSeconds: 6 } as unknown as DeckConfig;

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

  const flush = () => new Promise((r) => setTimeout(r, 300)); // past the console submit gap

  it("key 10 opens the pager straight to page two (default row already shows page one)", async () => {
    const { layer, controller, calls } = setup(["/a", "/b", "/c", "/d", "/e", "/f"]);
    (controller as any).row2(4); // pager key → jump past the visible page to the hidden /e /f
    expect(layer.row2Cmd.mode).toBe("pager");
    expect(layer.row2Cmd.page).toBe(1);
    (controller as any).row2(1); // tap /f → execute + close
    await flush();
    expect(calls).toEqual(["text:/f", "key:enter"]);
    expect(layer.row2Cmd.mode).toBe("default");
  });

  it("the Page key cycles forward through pages and wraps (never a dead-end)", () => {
    const { layer, controller } = setup(["/a", "/b", "/c", "/d", "/e", "/f"]); // 2 pages
    (controller as any).row2(4); // open → page two (index 1)
    expect(layer.row2Cmd.page).toBe(1);
    (controller as any).row2(4); // cycle → page one (index 0)
    expect(layer.row2Cmd.mode).toBe("pager");
    expect(layer.row2Cmd.page).toBe(0);
    (controller as any).row2(4); // wrap → page two (index 1)
    expect(layer.row2Cmd.page).toBe(1);
  });

  it("reverts to the default view after cmdPagerRevertSeconds without a Page press", () => {
    vi.useFakeTimers();
    const { layer, controller } = setup(["/a", "/b", "/c", "/d", "/e", "/f"]);
    (controller as any).row2(4); // open pager
    expect(layer.row2Cmd.mode).toBe("pager");
    vi.advanceTimersByTime(cfg.cmdPagerRevertSeconds * 1000 + 50);
    expect(layer.row2Cmd.mode).toBe("default");
    expect(layer.row2Cmd.page).toBe(0);
    vi.useRealTimers();
  });

  it("each Page press re-arms the idle-revert timer", () => {
    vi.useFakeTimers();
    const { layer, controller } = setup(["/a", "/b", "/c", "/d", "/e", "/f"]);
    (controller as any).row2(4); // open
    vi.advanceTimersByTime(cfg.cmdPagerRevertSeconds * 1000 - 100); // almost expired
    (controller as any).row2(4); // page press re-arms the timer
    vi.advanceTimersByTime(cfg.cmdPagerRevertSeconds * 1000 - 100); // old deadline would have fired
    expect(layer.row2Cmd.mode).toBe("pager");
    vi.advanceTimersByTime(200); // cross the re-armed deadline
    expect(layer.row2Cmd.mode).toBe("default");
    vi.useRealTimers();
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
    expect(store.all().map((e) => (e.kind === "builtin" ? e.id : e.label))).toEqual(["/b", "/c", "/a", "/d", "/e"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toEqual(["/b", "/c", "/a", "/d", "/e"]);
    vi.useRealTimers();
  });
});
