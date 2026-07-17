import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, initialRow2Cmd, pttTile, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";
import type { SttEngine, SttStatus } from "../src/stt/sidecar.js";

const cfg = {
  slots: 5,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  ptt: { enabled: true, python: "python", model: "m", language: "en", minHoldMs: 300, maxSeconds: 60 },
} as unknown as DeckConfig;
const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

class StubStt implements SttEngine {
  status: SttStatus = "ready";
  calls: string[] = [];
  text = "fix the failing registry test";
  async ensureStarted(): Promise<void> {
    this.calls.push("ensureStarted");
  }
  async start(): Promise<boolean> {
    this.calls.push("start");
    if (this.status !== "ready") return false;
    this.status = "recording";
    return true;
  }
  async stop(): Promise<string> {
    this.calls.push("stop");
    this.status = "ready";
    return this.text;
  }
  async cancel(): Promise<void> {
    this.calls.push("cancel");
    this.status = "ready";
  }
}

class RecordingAdapter implements DeliveryAdapter {
  calls: Array<{ m: string; arg?: string }> = [];
  async focus(): Promise<boolean> { this.calls.push({ m: "focus" }); return true; }
  async sendText(_s: SessionRef, t: string): Promise<boolean> { this.calls.push({ m: "sendText", arg: t }); return true; }
  async sendKey(_s: SessionRef, c: string): Promise<boolean> { this.calls.push({ m: "sendKey", arg: c }); return true; }
  async sendSequence(): Promise<boolean> { return true; }
  async findWindowByPid(): Promise<number | null> { return null; }
  async checkWindow(): Promise<boolean | null> { return null; }
  async dispose(): Promise<void> {}
}

describe("push-to-talk (hold mic → record → release → text lands unsent)", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let delivery: RecordingAdapter;
  let stt: StubStt;
  let controller: DeckController;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls() };
    delivery = new RecordingAdapter();
    stt = new StubStt();
    controller = new DeckController(registry, layer, delivery, cfg, noopLog, () => {});
    controller.setStt(stt);
  });
  afterEach(() => vi.useRealTimers());

  it("hold → release delivers the transcription WITHOUT Enter", async () => {
    controller.down(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start"]);
    await vi.advanceTimersByTimeAsync(1000); // held past minHoldMs
    controller.up(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls).toEqual([{ m: "sendText", arg: "fix the failing registry test" }]);
  });

  it("a sub-minHold press cancels — nothing recorded, nothing delivered", async () => {
    controller.down(10);
    await vi.advanceTimersByTimeAsync(100); // released too early
    controller.up(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start", "cancel"]);
    expect(delivery.calls).toEqual([]);
  });

  it("empty transcription delivers nothing", async () => {
    stt.text = "";
    controller.down(10);
    await vi.advanceTimersByTimeAsync(1000);
    controller.up(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery.calls).toEqual([]);
  });

  it("holding past maxSeconds auto-stops and delivers", async () => {
    controller.down(10);
    await vi.advanceTimersByTimeAsync(60_000 + 50); // cap fires while held
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls).toEqual([{ m: "sendText", arg: "fix the failing registry test" }]);
    controller.up(10); // release after auto-stop is a no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start", "stop"]);
  });

  it("a press while offline retries the sidecar instead of recording", async () => {
    stt.status = "offline";
    controller.down(10);
    await vi.advanceTimersByTimeAsync(0);
    controller.up(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["ensureStarted"]);
    expect(delivery.calls).toEqual([]);
  });

  it("no targeted session → no recording", async () => {
    const empty = new SessionRegistry(5);
    const c = new DeckController(empty, layer, delivery, cfg, noopLog, () => {});
    c.setStt(stt);
    c.down(10);
    await vi.advanceTimersByTimeAsync(0);
    c.up(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual([]);
  });

  it("on globals page 2 the mic slot is NOT ptt (Mode menu lives there)", async () => {
    layer.row3Page = 1;
    controller.down(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual([]); // went to the gesture recognizer instead
    controller.up(10);
    await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10);
  });
});

describe("pttTile faces", () => {
  it("maps each sidecar state to a distinct key face", () => {
    expect(pttTile(undefined, false)).toMatchObject({ subtext: "offline", state: "blank" });
    expect(pttTile("loading", false)).toMatchObject({ subtext: "loading…" });
    expect(pttTile("ready", false)).toMatchObject({ subtext: "hold to talk", state: "command" });
    expect(pttTile("recording", true)).toMatchObject({ text: "REC", state: "error", selected: true });
    expect(pttTile("transcribing", false)).toMatchObject({ subtext: "transcribing…", state: "waiting" });
  });
});
