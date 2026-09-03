import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { computeTiles, initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import { NoopAdapter } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const cfg = {
  slots: 5, desktopJumpSettleMs: 0,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  restartCommand: "Start-ScheduledTask -TaskName 'Conn Bridge'",
} as unknown as DeckConfig;

// Page 2 of the globals row (row3Page 1) — where Tidy lives (key 13 = index 3).
function page2(): DeckLayerState {
  return { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 1, controls: initialControls() };
}

type Row3 = { row3(i: number): Promise<void> };

function makeController(registry: SessionRegistry, layer: DeckLayerState) {
  return new DeckController(registry, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
}

describe("Tidy (row 3, page 2) — sweep cohort picker", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let row3: (i: number) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry(5);
    registry.addKnownTerminal({ sessionId: "con", pid: 1 }); // console
    registry.ensure({ session_id: "desk", cwd: "C:\\dev\\desk", hook_event_name: "SessionStart" }); // desktop
    layer = page2();
    const controller = makeController(registry, layer);
    row3 = (controller as unknown as Row3).row3.bind(controller);
  });
  afterEach(() => vi.useRealTimers());

  it("the Tidy key (index 3) wears the bin until armed", () => {
    expect(computeTiles(registry, layer, cfg)[13]).toMatchObject({ text: "Tidy", icon: "trash" });
  });

  it("arming turns the verb row into the cohort picker", async () => {
    await row3(3); // Tidy
    expect(layer.sweepMenu).toBe(true);
    const tiles = computeTiles(registry, layer, cfg);
    expect(tiles[10]).toMatchObject({ text: "Consoles" });
    expect(tiles[11]).toMatchObject({ text: "Windows" });
    expect(tiles[12]).toMatchObject({ text: "All" });
    expect(tiles[13]).toMatchObject({ text: "Cancel" });
  });

  it("Consoles hides console sessions and closes the menu", async () => {
    await row3(3); // arm
    await row3(0); // Consoles
    expect(layer.sweepMenu).toBe(false);
    expect(registry.orderedEntries().map((s) => s.sessionId)).toEqual(["desk"]);
    expect(registry.get("con")?.hidden).toBe(true);
  });

  it("Windows hides desktop app tabs", async () => {
    await row3(3); // arm
    await row3(1); // Windows
    expect(registry.orderedEntries().map((s) => s.sessionId)).toEqual(["con"]);
  });

  it("All hides both cohorts", async () => {
    await row3(3); // arm
    await row3(2); // All
    expect(registry.orderedEntries()).toHaveLength(0);
  });

  it("Cancel (index 3) closes without sweeping anything", async () => {
    await row3(3); // arm
    await row3(3); // Cancel
    expect(layer.sweepMenu).toBe(false);
    expect(registry.orderedEntries().map((s) => s.sessionId)).toEqual(["con", "desk"]);
  });

  it("the far-right key (index 4) also just closes the armed menu", async () => {
    await row3(3); // arm
    await row3(4); // Page/last key while armed → cancel, stay on page 2
    expect(layer.sweepMenu).toBe(false);
    expect(layer.row3Page).toBe(1);
    expect(registry.orderedEntries()).toHaveLength(2);
  });

  it("the menu auto-disarms after its window, sweeping nothing", async () => {
    await row3(3); // arm
    expect(layer.sweepMenu).toBe(true);
    vi.advanceTimersByTime(4100);
    expect(layer.sweepMenu).toBe(false);
    expect(registry.orderedEntries()).toHaveLength(2);
  });
});

describe("globals row paging (Page key = index 4)", () => {
  it("cycles 0 → 1 → 2 → 0 when a restart command supplies page 3", async () => {
    const layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls() } as DeckLayerState;
    const controller = makeController(new SessionRegistry(5), layer);
    const row3 = (controller as unknown as Row3).row3.bind(controller);
    await row3(4);
    expect(layer.row3Page).toBe(1);
    await row3(4);
    expect(layer.row3Page).toBe(2);
    await row3(4);
    expect(layer.row3Page).toBe(0);
  });

  it("only two pages when there's no restart command — page 3 has nothing to hold", async () => {
    const off = { ...cfg, restartCommand: "" } as unknown as DeckConfig;
    const layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls() } as DeckLayerState;
    const registry = new SessionRegistry(5);
    const controller = new DeckController(registry, layer, new NoopAdapter(() => {}), off, noopLog, () => {});
    const row3 = (controller as unknown as Row3).row3.bind(controller);
    await row3(4);
    expect(layer.row3Page).toBe(1);
    await row3(4);
    expect(layer.row3Page).toBe(0);
  });
});
