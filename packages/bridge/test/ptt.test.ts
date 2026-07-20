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
  ptt: { enabled: true, python: "python", model: "m", language: "en", maxSeconds: 60, reasonMaxSeconds: 10 },
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

/** Tap the mic key (down edge acts; up is swallowed). */
function tapMic(c: DeckController) {
  c.down(10);
  c.up(10);
}

/** Tap a row-3 key that goes through the gesture recognizer (e.g. Send). */
async function tapKey(c: DeckController, slot: number) {
  c.down(slot);
  c.up(slot);
  await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10); // resolve the tap
}

describe("dictation toggle (tap → record, tap → stop & type)", () => {
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

  it("tap starts, second tap stops and types WITHOUT Enter", async () => {
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start"]);

    await vi.advanceTimersByTimeAsync(5_000); // think as long as you like
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls).toEqual([{ m: "sendText", arg: "fix the failing registry test" }]);
  });

  it("Send mid-recording stops, types, AND submits", async () => {
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    await tapKey(controller, 11); // Send
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls).toEqual([
      { m: "sendText", arg: "fix the failing registry test" },
      { m: "sendKey", arg: "enter" },
    ]);
  });

  it("Send while idle is a plain Enter", async () => {
    await tapKey(controller, 11);
    expect(stt.calls).toEqual([]);
    expect(delivery.calls).toEqual([{ m: "sendKey", arg: "enter" }]);
  });

  it("Send never hijacks a deny-reason recording (not ours)", async () => {
    stt.status = "recording"; // deny-reason flow owns the mic
    await tapKey(controller, 11);
    expect(stt.calls).toEqual([]); // no stop from us
    expect(delivery.calls).toEqual([{ m: "sendKey", arg: "enter" }]);
  });

  it("mic tap ends a deny-reason dictation through its own key", async () => {
    const pressed: number[] = [];
    const c = new DeckController(registry, layer, delivery, cfg, noopLog, () => {}, {
      onPermissionKey: (i) => pressed.push(i),
    });
    c.setStt(stt);
    stt.status = "recording"; // deny-reason holds the mic
    layer.permissionRec = { deadline: Date.now() + 10_000 };
    tapMic(c);
    await vi.advanceTimersByTimeAsync(0);
    expect(pressed).toEqual([3]); // routed to the Deny + reason key
    expect(stt.calls).toEqual([]); // never grabbed the engine itself
    layer.permissionRec = undefined;
  });

  it("mic tap is ignored when the engine is busy with nothing of ours", async () => {
    stt.status = "recording"; // no rename, no permissionRec — not ours to stop
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual([]);
  });

  it("empty transcription types nothing; Send-stop still submits", async () => {
    stt.text = "";
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    await tapKey(controller, 11); // Send while recording
    expect(delivery.calls).toEqual([{ m: "sendKey", arg: "enter" }]); // no sendText
  });

  it("forgotten recording auto-stops at maxSeconds and types, never sends", async () => {
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000 + 50);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls).toEqual([{ m: "sendText", arg: "fix the failing registry test" }]);
    tapMic(controller); // next tap starts a FRESH recording
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start", "stop", "start"]);
  });

  it("a tap while offline retries the sidecar instead of recording", async () => {
    stt.status = "offline";
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["ensureStarted"]);
    expect(delivery.calls).toEqual([]);
  });

  it("no targeted session → no recording", async () => {
    const empty = new SessionRegistry(5);
    const c = new DeckController(empty, layer, delivery, cfg, noopLog, () => {});
    c.setStt(stt);
    tapMic(c);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual([]);
  });

  it("on globals page 2 the mic slot is NOT dictation (Mode menu lives there)", async () => {
    layer.row3Page = 1;
    controller.down(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual([]); // went to the gesture recognizer instead
    controller.up(10);
    await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10);
  });

  it("a LIVE recording keeps owning the mic key even after the page flips", async () => {
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start"]);
    layer.row3Page = 1; // user flips to globals page 2 mid-recording
    tapMic(controller); // still stops the dictation, not Mode-menu
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(delivery.calls).toEqual([{ m: "sendText", arg: "fix the failing registry test" }]);
  });
});

describe("pttTile faces", () => {
  it("maps each sidecar state to a distinct key face", () => {
    expect(pttTile(undefined, false)).toMatchObject({ subtext: "offline", state: "blank" });
    expect(pttTile("loading", false)).toMatchObject({ subtext: "loading…" });
    expect(pttTile("ready", false)).toMatchObject({ subtext: "tap to talk", state: "command" });
    expect(pttTile("recording", true)).toMatchObject({ text: "REC", subtext: "tap to stop", state: "error", selected: true });
    expect(pttTile("transcribing", false)).toMatchObject({ subtext: "transcribing…", state: "waiting" });
  });
});
