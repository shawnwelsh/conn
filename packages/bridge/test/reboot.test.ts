import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { computeTiles, initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
import { canReboot, type DeckConfig } from "../src/config.js";
import { NoopAdapter } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never;
const cfg = {
  slots: 5,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  restartCommand: "Start-ScheduledTask -TaskName 'Conn Bridge'",
} as unknown as DeckConfig;

// Page 3 of the globals row, where the Reboot key now lives (key 10 = index 0).
// (It moved off page 2 to make room for Tidy.)
function page3(): DeckLayerState {
  return { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 2, controls: initialControls() };
}

describe("Reboot bridge key (row 3, page 3) — two-step confirm", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let controller: DeckController;
  let reboots: number;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry(5);
    layer = page3();
    controller = new DeckController(registry, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
    reboots = 0;
    controller.setHooks({ onReboot: () => { reboots++; } });
  });
  afterEach(() => vi.useRealTimers());

  it("first press only arms it — a red Confirm?, no reboot", async () => {
    await (controller as unknown as { row3(i: number): Promise<void> }).row3(0);
    expect(layer.rebootArmed).toBe(true);
    expect(reboots).toBe(0);
    expect(computeTiles(registry, layer, cfg)[10]).toMatchObject({ text: "Confirm?", state: "error" });
  });

  it("a second press within the window fires the reboot and disarms", async () => {
    const row3 = (controller as unknown as { row3(i: number): Promise<void> }).row3.bind(controller);
    await row3(0); // arm
    await row3(0); // confirm
    expect(layer.rebootArmed).toBe(false);
    // The reboot is deferred a beat so the REBOOTING frame ships first.
    expect(reboots).toBe(0);
    vi.advanceTimersByTime(500);
    expect(reboots).toBe(1);
  });

  it("no second press: it disarms after the timeout and never reboots", async () => {
    await (controller as unknown as { row3(i: number): Promise<void> }).row3(0); // arm
    expect(layer.rebootArmed).toBe(true);
    vi.advanceTimersByTime(3100);
    expect(layer.rebootArmed).toBe(false);
    expect(reboots).toBe(0);
  });

  it("unarmed it reads 'Reboot'; with no way back at all the key is hidden", () => {
    expect(computeTiles(registry, layer, cfg)[10]).toMatchObject({ text: "Reboot", state: "command" });
    const off = { ...cfg, restartCommand: "", supervised: false } as unknown as DeckConfig;
    expect(computeTiles(registry, layer, off)[10]).toMatchObject({ state: "blank" });
  });

  it("a SUPERVISED bridge offers Reboot even with no restartCommand", () => {
    // Supervised is the good path: exiting is enough, so the legacy command is
    // irrelevant — and the key must not disappear just because it's unset.
    const sup = { ...cfg, restartCommand: "", supervised: true } as unknown as DeckConfig;
    expect(computeTiles(registry, layer, sup)[10]).toMatchObject({ text: "Reboot", state: "command" });
  });
});

describe("canReboot — is there any way back after we exit?", () => {
  it("true when supervised, or when a legacy restart command exists", () => {
    expect(canReboot({ supervised: true })).toBe(true);
    expect(canReboot({ supervised: true, restartCommand: "" })).toBe(true);
    expect(canReboot({ restartCommand: "Start-ScheduledTask -TaskName 'Conn Bridge'" })).toBe(true);
  });

  it("false when neither — exiting would just leave a dead deck", () => {
    expect(canReboot({})).toBe(false);
    expect(canReboot({ supervised: false, restartCommand: "" })).toBe(false);
  });
});

// A bridge that exits without saying so leaves a deck that looks completely
// normal and silently ignores every press — indistinguishable from a hang.
describe("REBOOTING takeover screen", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let controller: DeckController;
  let reboots: number;
  let row3: (i: number) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\s1", hook_event_name: "SessionStart" });
    layer = page3();
    controller = new DeckController(registry, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
    reboots = 0;
    controller.setHooks({ onReboot: () => { reboots++; } });
    row3 = (controller as unknown as { row3(i: number): Promise<void> }).row3.bind(controller);
  });
  afterEach(() => vi.useRealTimers());

  it("a confirmed reboot takes over all 15 keys before anything tears down", async () => {
    await row3(0); // arm
    await row3(0); // confirm
    expect(layer.rebooting).toBe(true);
    const tiles = computeTiles(registry, layer, cfg);
    expect(tiles).toHaveLength(15);
    // Row 1 spells it out across the full width; row 2 says what's happening.
    for (let i = 0; i < 5; i++) {
      expect(tiles[i]).toMatchObject({ text: "REBOOTING", bannerSpan: 5, bannerIndex: i });
    }
    for (let i = 5; i < 10; i++) expect(tiles[i]!.text).toBe("bridge restarting…");
    for (let i = 10; i < 15; i++) expect(tiles[i]).toMatchObject({ state: "blank" });
    // Not one session key survives — the deck cannot look "normal" here.
    expect(tiles.some((t) => t.text === "s1")).toBe(false);
  });

  it("the screen goes up BEFORE the reboot fires, so the frame can ship", async () => {
    await row3(0);
    await row3(0);
    expect(layer.rebooting).toBe(true);
    expect(reboots).toBe(0); // still queued
    vi.advanceTimersByTime(500);
    expect(reboots).toBe(1);
  });

  it("restores the deck if the bridge is somehow still alive — never a stuck lie", async () => {
    await row3(0);
    await row3(0);
    vi.advanceTimersByTime(500); // reboot fires; in this test the process lives on
    expect(layer.rebooting).toBe(true);
    vi.advanceTimersByTime(15_100);
    expect(layer.rebooting).toBe(false);
    expect(computeTiles(registry, layer, cfg)[0]!.text).toBe("s1"); // normal deck back
  });
});
