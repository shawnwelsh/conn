import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GestureRecognizer } from "../src/gestures.js";

describe("GestureRecognizer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const events: Array<{ slot: number; g: string }> = [];
    const r = new GestureRecognizer(
      { doubleTapMs: 300, longPressMs: 500 },
      (slot, g) => events.push({ slot, g }),
      () => Date.now(),
    );
    return { r, events };
  }

  it("short press → tap (after the double-tap window)", () => {
    const { r, events } = setup();
    r.down(0);
    vi.advanceTimersByTime(100);
    r.up(0);
    expect(events).toEqual([]); // still waiting to see if a second tap comes
    vi.advanceTimersByTime(300);
    expect(events).toEqual([{ slot: 0, g: "tap" }]);
  });

  it("two quick presses → double, no tap", () => {
    const { r, events } = setup();
    r.down(0); vi.advanceTimersByTime(80); r.up(0);
    vi.advanceTimersByTime(120);
    r.down(0); vi.advanceTimersByTime(80); r.up(0);
    expect(events).toEqual([{ slot: 0, g: "double" }]);
    vi.advanceTimersByTime(400);
    expect(events).toEqual([{ slot: 0, g: "double" }]); // no stray tap
  });

  it("hold past longPressMs → long, fires while held, no tap on release", () => {
    const { r, events } = setup();
    r.down(0);
    vi.advanceTimersByTime(500);
    expect(events).toEqual([{ slot: 0, g: "long" }]);
    r.up(0);
    vi.advanceTimersByTime(400);
    expect(events).toEqual([{ slot: 0, g: "long" }]);
  });

  it("three quick presses → triple, riding the double it already fired", () => {
    const { r, events } = setup();
    const quickTap = () => { r.down(0); vi.advanceTimersByTime(60); r.up(0); vi.advanceTimersByTime(80); };
    quickTap();
    quickTap();
    quickTap();
    // Double stays instant (focus must not lag); triple lands on top of it.
    expect(events).toEqual([{ slot: 0, g: "double" }, { slot: 0, g: "triple" }]);
    vi.advanceTimersByTime(400);
    expect(events).toHaveLength(2); // no trailing tap
  });

  it("a slow third press starts a fresh chain instead of a triple", () => {
    const { r, events } = setup();
    r.down(0); vi.advanceTimersByTime(60); r.up(0); vi.advanceTimersByTime(80);
    r.down(0); vi.advanceTimersByTime(60); r.up(0);
    expect(events).toEqual([{ slot: 0, g: "double" }]);
    vi.advanceTimersByTime(400); // gap exceeds the window
    r.down(0); vi.advanceTimersByTime(60); r.up(0);
    vi.advanceTimersByTime(400);
    expect(events).toEqual([{ slot: 0, g: "double" }, { slot: 0, g: "tap" }]);
  });

  it("keeps slots independent", () => {
    const { r, events } = setup();
    r.down(0); vi.advanceTimersByTime(500); // slot 0 long
    r.down(1); vi.advanceTimersByTime(50); r.up(1); vi.advanceTimersByTime(300); // slot 1 tap
    expect(events).toContainEqual({ slot: 0, g: "long" });
    expect(events).toContainEqual({ slot: 1, g: "tap" });
  });
});
