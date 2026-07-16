import { describe, expect, it, beforeEach } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";

const cfg = { slots: 5, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5, cannedCommands: {} } as unknown as DeckConfig;
const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const flush = () => new Promise((r) => setTimeout(r, 10));

class RecordingAdapter implements DeliveryAdapter {
  calls: Array<{ m: string; chords: string[] }> = [];
  async focus(): Promise<boolean> { return true; }
  async sendText(): Promise<boolean> { return true; }
  async sendKey(_s: SessionRef, chord: string): Promise<boolean> {
    this.calls.push({ m: "sendKey", chords: [chord] });
    return true;
  }
  async sendSequence(_s: SessionRef, chords: string[]): Promise<boolean> {
    this.calls.push({ m: "sendSequence", chords });
    return true;
  }
  async findWindowByPid(): Promise<number | null> { return null; }
  async dispose(): Promise<void> {}
}

describe("Plan/Model blind toggles", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let delivery: RecordingAdapter;
  let controller: DeckController;

  beforeEach(() => {
    registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    layer = { row1: initialRow1(), row2: "idle", controls: initialControls() };
    delivery = new RecordingAdapter();
    controller = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
  });

  it("Plan alternates Ctrl+Shift+M 4 (plan) then 3 (auto), flipping the label state", async () => {
    // row2 is fire-and-forget; flush the microtask/timeout after each press.
    (controller as any).row2(0);
    await flush();
    expect(delivery.calls.at(-1)).toEqual({ m: "sendSequence", chords: ["ctrl+shift+m", "4"] });
    expect(layer.controls.planNext).toBe("auto");

    (controller as any).row2(0);
    await flush();
    expect(delivery.calls.at(-1)).toEqual({ m: "sendSequence", chords: ["ctrl+shift+m", "3"] });
    expect(layer.controls.planNext).toBe("plan");
  });

  it("Model cycles Ctrl+Shift+I 1→2→3→4→1", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await (controller as any).row3(3);
      seen.push(delivery.calls.at(-1)!.chords[1]!);
    }
    expect(seen).toEqual(["1", "2", "3", "4", "1"]);
    expect(delivery.calls.every((c) => c.chords[0] === "ctrl+shift+i")).toBe(true);
  });
});
