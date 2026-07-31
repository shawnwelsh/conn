import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { computeTiles, initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import { NoopAdapter } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const cfg = {
  slots: 5,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  restartCommand: "Start-ScheduledTask -TaskName 'Conn Bridge'",
} as unknown as DeckConfig;

// Page 2 of the globals row, where the Reboot key lives (key 13 = index 3).
function page2(): DeckLayerState {
  return { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 1, controls: initialControls() };
}

describe("Reboot bridge key (row 3, page 2) — two-step confirm", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let controller: DeckController;
  let reboots: number;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry(5);
    layer = page2();
    controller = new DeckController(registry, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
    reboots = 0;
    controller.setHooks({ onReboot: () => { reboots++; } });
  });
  afterEach(() => vi.useRealTimers());

  it("first press only arms it — a red Confirm?, no reboot", async () => {
    await (controller as unknown as { row3(i: number): Promise<void> }).row3(3);
    expect(layer.rebootArmed).toBe(true);
    expect(reboots).toBe(0);
    expect(computeTiles(registry, layer, cfg)[13]).toMatchObject({ text: "Confirm?", state: "error" });
  });

  it("a second press within the window fires the reboot and disarms", async () => {
    const row3 = (controller as unknown as { row3(i: number): Promise<void> }).row3.bind(controller);
    await row3(3); // arm
    await row3(3); // confirm
    expect(reboots).toBe(1);
    expect(layer.rebootArmed).toBe(false);
  });

  it("no second press: it disarms after the timeout and never reboots", async () => {
    await (controller as unknown as { row3(i: number): Promise<void> }).row3(3); // arm
    expect(layer.rebootArmed).toBe(true);
    vi.advanceTimersByTime(3100);
    expect(layer.rebootArmed).toBe(false);
    expect(reboots).toBe(0);
  });

  it("unarmed it reads 'Reboot'; an empty restartCommand hides the key", () => {
    expect(computeTiles(registry, layer, cfg)[13]).toMatchObject({ text: "Reboot", state: "command" });
    const off = { ...cfg, restartCommand: "" } as unknown as DeckConfig;
    expect(computeTiles(registry, layer, off)[13]).toMatchObject({ state: "blank" });
  });
});
