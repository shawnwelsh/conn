import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, initialRow2Cmd, pttTile, computeTiles, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";
import type { SttEngine, SttStatus } from "../src/stt/sidecar.js";

const cfg = {
  slots: 5, desktopJumpSettleMs: 0,
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

  it("Send mid-recording stops, types, AND submits — with a settle gap", async () => {
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    await tapKey(controller, 11); // Send
    expect(stt.calls).toEqual(["start", "stop"]);
    // The Enter must NOT be instant: it lands as a newline if it arrives
    // while the typed text is still draining into the input.
    expect(delivery.calls).toEqual([{ m: "sendText", arg: "fix the failing registry test" }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(delivery.calls).toEqual([
      { m: "sendText", arg: "fix the failing registry test" },
      { m: "sendKey", arg: "enter" },
    ]);
  });

  it("the Send key advertises the shortcut only while WE hold the mic", async () => {
    // Plain Send carries no subtext: "enter" was a caption on a paper plane.
    // The compound behaviour is the only thing worth spending the line on.
    const tiles = () => computeTiles(registry, layer, cfg, [], false);
    expect(tiles()[11]).toMatchObject({ text: "Send", state: "command" });
    expect(tiles()[11]!.subtext).toBeUndefined();

    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.talkActive).toBe(true);
    expect(tiles()[11]).toMatchObject({ text: "Send", subtext: "stop + send", state: "answer", icon: "send" });

    await tapKey(controller, 11);
    expect(layer.talkActive).toBeUndefined();
    expect(tiles()[11]!.subtext).toBeUndefined();
  });

  it("a rename or deny-reason recording leaves Send looking like plain Enter", async () => {
    // Send really is a plain Enter during those — the key must not lie.
    layer.ptt = "recording";
    layer.permissionRec = { deadline: Date.now() + 10_000 };
    expect(computeTiles(registry, layer, cfg, [], false)[11]!.subtext).toBeUndefined();
    layer.permissionRec = undefined;
    layer.ptt = undefined;
  });

  it("flashes the DESTINATION session's key in sync with the mic, no static border otherwise", async () => {
    registry.ensure({ session_id: "s2", cwd: "C:\\dev\\y", hook_event_name: "SessionStart" });
    registry.target("s1");
    const s1Slot = registry.get("s1")!.slot;
    // Not recording: the targeted key has NO border — the veil marks it.
    expect(computeTiles(registry, layer, cfg, [], true)[s1Slot]!.selected).toBe(false);

    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.talkTarget).toBe("s1");
    // Recording: the destination flashes with the mic (both keyed off the
    // same flashPhase), and it's the ONLY row-1 key that does.
    expect(computeTiles(registry, layer, cfg, [], true)[s1Slot]!.selected).toBe(true);
    expect(computeTiles(registry, layer, cfg, [], false)[s1Slot]!.selected).toBe(false);
    const s2Slot = registry.get("s2")!.slot;
    expect(computeTiles(registry, layer, cfg, [], true)[s2Slot]!.selected).toBe(false);
  });

  it("marks the destination even if you retarget mid-utterance", async () => {
    registry.ensure({ session_id: "s2", cwd: "C:\\dev\\y", hook_event_name: "SessionStart" });
    registry.target("s1");
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    registry.target("s2"); // look at another session while still dictating to s1
    // The words go to s1 (captured at start), so s1's key keeps flashing.
    expect(layer.talkTarget).toBe("s1");
    const s1Slot = registry.get("s1")!.slot;
    expect(computeTiles(registry, layer, cfg, [], true)[s1Slot]!.selected).toBe(true);
  });

  it("Esc cancels a live dictation: purge the buffer, type NOTHING", async () => {
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.talkActive).toBe(true);
    // Esc is row-3 key index 2 → physical slot 12.
    await tapKey(controller, 12);
    expect(stt.calls).toEqual(["start", "cancel"]); // cancel, never stop
    expect(delivery.calls).toEqual([]); // nothing typed
    expect(layer.talkActive).toBeUndefined();
    expect(layer.talkTarget).toBeUndefined();
  });

  it("the Esc key reads Cancel while we hold the mic, Esc otherwise", async () => {
    const escTile = () => computeTiles(registry, layer, cfg, [], false)[12]!;
    expect(escTile().text).toBe("Esc");
    tapMic(controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(escTile()).toMatchObject({ text: "Cancel", subtext: "discard", state: "error", icon: "esc" });
  });

  it("Esc with no dictation still interrupts the targeted session", async () => {
    registry.target("s1");
    await tapKey(controller, 12);
    expect(delivery.calls).toEqual([{ m: "sendKey", arg: "escape" }]);
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
    // Subtext only where it says something the face can't. Ready and REC carry
    // none — "tap to start"/"tap to stop" were captions on an obvious mic, and
    // the destination is shown by flashing that session's key, not here.
    expect(pttTile(undefined, false)).toMatchObject({ subtext: "offline", state: "blank" });
    expect(pttTile("loading", false)).toMatchObject({ subtext: "loading…" });
    expect(pttTile("ready", false)).toMatchObject({ text: "Talk", state: "command" });
    expect(pttTile("ready", false).subtext).toBeUndefined();
    expect(pttTile("recording", true)).toMatchObject({ text: "REC", state: "error", selected: true });
    expect(pttTile("recording", true).subtext).toBeUndefined();
    expect(pttTile("transcribing", false)).toMatchObject({ subtext: "transcribing…", state: "waiting" });
  });
});
