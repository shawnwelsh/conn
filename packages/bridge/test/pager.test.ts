import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
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

describe("row-1 banner keys during a morph", () => {
  let r: SessionRegistry;
  let layer: DeckLayerState;
  let c: DeckController;
  let focused: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    r = new SessionRegistry(5);
    seed(r, ["a", "b", "c", "d"]);
    layer = {
      row1: initialRow1(),
      row2: "permission",
      row2Cmd: initialRow2Cmd(),
      row3Page: 0,
      permission: { sessionId: "d", toolName: "Bash", summary: "rm -rf build" },
      controls: { planNext: "plan", modelNext: 1 },
    };
    focused = [];
    const delivery = new NoopAdapter(() => {});
    delivery.focus = async (s) => {
      focused.push(s.sessionId);
      return true;
    };
    c = new DeckController(r, layer, delivery, cfg, noopLog, () => {});
  });
  afterEach(() => vi.useRealTimers());

  it("does not target the session that happens to sit under a banner key", async () => {
    // Keys 2-5 are one wide image, not sessions. Treating them as slots would
    // retarget — or worse, long-press-move — whoever occupied that slot.
    r.target("a");
    press(c, 2);
    await vi.advanceTimersByTimeAsync(400); // let the tap escape the double-tap window
    expect(r.targetedSession?.sessionId).toBe("a");
  });

  it("tapping the banner focuses the asking session, so you can go read it", async () => {
    press(c, 3);
    await vi.advanceTimersByTimeAsync(400);
    expect(focused).toEqual(["d"]);
  });

  it("long-pressing a banner key never starts a move", () => {
    c.down(1);
    vi.advanceTimersByTime(600);
    c.up(1);
    expect(layer.row1.mode).toBe("agents");
  });
});

describe("pager + long-press move (row-1 modes)", () => {
  let r: SessionRegistry;
  let layer: DeckLayerState;
  let c: DeckController;

  beforeEach(() => {
    vi.useFakeTimers();
    r = new SessionRegistry(5);
    seed(r, ["a", "b", "c", "d", "e", "f"]); // working [a,b,c,d], overflow [e,f]
    layer = {
      row1: initialRow1(),
      row2: "idle",
      row2Cmd: initialRow2Cmd(),
      row3Page: 0,
      controls: { planNext: "plan", modelNext: 1 },
    };
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

  it("the Page key cycles pages in place — no separate browse mode", () => {
    // 6 sessions, 4 per page → 2 pages.
    expect(layer.row1.page).toBe(0);
    tap(4);
    expect(layer.row1.mode).toBe("agents"); // never leaves the session row
    expect(layer.row1.page).toBe(1);
    tap(4);
    expect(layer.row1.page).toBe(0); // wraps
  });

  it("using a session on page 2 leaves you on page 2, and does not reorder", () => {
    // The old pager promoted the picked session to slot #1 and closed itself,
    // so the row rearranged and you lost your place. Press = use, nothing else.
    const orderBefore = r.orderedEntries().map((s) => s.sessionId);
    tap(4); // → page 2, showing [e, f]
    tap(0); // use "e"
    expect(r.targetedSession?.sessionId).toBe("e");
    expect(layer.row1.page).toBe(1);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(orderBefore);
  });

  it("long-press on page 2 moves that session, not whoever sits in page 1's slot", () => {
    tap(4); // → page 2: [e, f]
    longPress(1); // "f"
    expect(layer.row1.mode).toBe("move");
    expect(layer.row1.moveSource).toBe("f");
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
