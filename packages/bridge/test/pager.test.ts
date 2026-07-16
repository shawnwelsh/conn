import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialRow1, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import { NoopAdapter } from "../src/delivery/adapter.js";

const cfg = {
  slots: 5,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  cannedCommands: {},
} as unknown as DeckConfig;
const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

function seed(r: SessionRegistry, ids: string[]) {
  for (const id of ids) r.ensure({ session_id: id, cwd: `C:\\dev\\${id}`, hook_event_name: "SessionStart" });
}

/** Drive a full press (down then up) through the recognizer synchronously. */
function press(c: DeckController, slot: number) {
  c.down(slot);
  c.up(slot);
}

describe("pager + long-press move (row-1 modes)", () => {
  let r: SessionRegistry;
  let layer: DeckLayerState;
  let c: DeckController;

  beforeEach(() => {
    vi.useFakeTimers();
    r = new SessionRegistry(5);
    seed(r, ["a", "b", "c", "d", "e", "f"]); // working [a,b,c,d], overflow [e,f]
    layer = { row1: initialRow1(), row2: "idle", controls: { planNext: "plan", modelNext: 1 } };
    c = new DeckController(r, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
  });
  afterEach(() => vi.useRealTimers());

  function tap(slot: number) {
    press(c, slot);
    vi.advanceTimersByTime(cfg.doubleTapMs + 5); // resolve the single-tap
  }
  function longPress(slot: number) {
    c.down(slot);
    vi.advanceTimersByTime(cfg.longPressMs + 5); // fires "long" while held
    c.up(slot);
  }

  it("tap Pager opens the picker; tapping a listed session promotes it to slot #1", () => {
    tap(4); // pager slot
    expect(layer.row1.mode).toBe("pager");
    // overflow is [e,f] (or MRU); pick slot 0 → the first overflow entry
    const firstOverflow = r.overflowEntries()[0]!.sessionId;
    tap(0);
    expect(layer.row1.mode).toBe("agents");
    expect(r.snapshot().working[0]).toBe(firstOverflow);
    expect(r.targetedSession?.sessionId).toBe(firstOverflow);
  });

  it("long-press a working session then tap a slot performs an insert-before move", () => {
    // working [a,b,c,d]; long-press a (slot 0), then tap slot 2 (button 3) → [b,c,a,d]
    longPress(0);
    expect(layer.row1.mode).toBe("move");
    expect(layer.row1.moveSource).toBe("a");
    tap(2);
    expect(layer.row1.mode).toBe("agents");
    expect(r.snapshot().working).toEqual(["b", "c", "a", "d"]);
  });

  it("a pending move cancels after moveCancelSeconds with no target", () => {
    longPress(0);
    expect(layer.row1.mode).toBe("move");
    vi.advanceTimersByTime(cfg.moveCancelSeconds * 1000 + 50);
    expect(layer.row1.mode).toBe("agents");
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]); // unchanged
  });

  it("Cancel key (last slot) aborts a pending move", () => {
    longPress(0);
    tap(4);
    expect(layer.row1.mode).toBe("agents");
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]);
  });
});
