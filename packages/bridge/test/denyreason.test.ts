import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DecisionStore } from "../src/decisions.js";
import { DenyReasonFlow } from "../src/denyReason.js";
import { initialControls, initialRow1, initialRow2Cmd, type DeckLayerState } from "../src/layers.js";
import type { SttEngine, SttStatus } from "../src/stt/sidecar.js";
import type { AnyHookEvent } from "../src/hookTypes.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

class FakeStt implements SttEngine {
  status: SttStatus = "ready";
  startOk = true;
  text = "because that touches prod";
  started = 0;
  stopped = 0;
  cancelled = 0;
  async start(): Promise<boolean> {
    this.started++;
    if (!this.startOk) return false;
    this.status = "recording";
    return true;
  }
  async stop(): Promise<string> {
    this.stopped++;
    this.status = "ready";
    return this.text;
  }
  async cancel(): Promise<void> {
    this.cancelled++;
    this.status = "ready";
  }
}

function permissionEvent(id: string): AnyHookEvent {
  return {
    session_id: id,
    cwd: "C:\\dev\\x",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build" },
  } as AnyHookEvent;
}

/** Body → the decision object CC receives. */
function decisionOf(body: unknown): Record<string, unknown> | undefined {
  return (body as { hookSpecificOutput?: { decision?: Record<string, unknown> } })?.hookSpecificOutput?.decision;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("deny-with-dictated-reason", () => {
  let layer: DeckLayerState;
  let store: DecisionStore;
  let stt: FakeStt;
  let flow: DenyReasonFlow;

  beforeEach(() => {
    vi.useFakeTimers();
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls(), ptt: "ready" };
    stt = new FakeStt();
    store = new DecisionStore(
      30_000,
      noopLog,
      () => true,
      () => flow.sync(), // mirrors index.ts: queue changes re-sync the flow
      "session",
    );
    flow = new DenyReasonFlow(store, stt, layer, 10, noopLog, () => {});
  });
  afterEach(() => vi.useRealTimers());

  it("an injected resolver receives the transcription (the plan 'say why' path)", async () => {
    // A plan can't deny through the hook, so index.ts injects a resolver that
    // types the reason instead. Same recording UI — different last step.
    const got: Array<string | null> = [];
    const planFlow = new DenyReasonFlow(store, stt, layer, 10, noopLog, () => {}, (text) => got.push(text));
    store.hold(permissionEvent("s1"));
    planFlow.press();
    await flush();
    expect(layer.permissionRec).toBeDefined(); // the SAME countdown UI as deny-reason
    planFlow.press(); // stop early
    await flush();
    expect(got).toEqual(["because that touches prod"]);
  });

  it("the injected resolver gets null when the sidecar can't record", async () => {
    const got: Array<string | null> = [];
    stt.status = "offline";
    const planFlow = new DenyReasonFlow(store, stt, layer, 10, noopLog, () => {}, (text) => got.push(text));
    store.hold(permissionEvent("s1"));
    planFlow.press();
    await flush();
    expect(got).toEqual([null]); // no mic → resolver still fires, with no reason
  });

  it("press → record → press again → deny resolves with the dictated reason", async () => {
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    await flush();
    expect(stt.started).toBe(1);
    expect(flow.recording).toBe(true);
    expect(layer.permissionRec).toBeDefined();

    flow.press(); // stop early
    await flush();
    const d = decisionOf(await resolved);
    expect(d).toEqual({ behavior: "deny", message: "because that touches prod" });
    expect(flow.recording).toBe(false);
    expect(layer.permissionRec).toBeUndefined();
    expect(store.current).toBeUndefined();
  });

  it("recording window elapsing auto-stops and resolves with the reason", async () => {
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const d = decisionOf(await resolved);
    expect(d).toEqual({ behavior: "deny", message: "because that touches prod" });
  });

  it("empty transcription falls back to the canned deny message", async () => {
    stt.text = "  ";
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    await flush();
    flow.press();
    const d = decisionOf(await resolved);
    expect(d).toEqual({ behavior: "deny", message: "Denied from Conn" });
  });

  it("sidecar not ready → immediate canned deny, no recording", async () => {
    stt.status = "offline";
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    const d = decisionOf(await resolved);
    expect(d).toEqual({ behavior: "deny", message: "Denied from Conn" });
    expect(stt.started).toBe(0);
    expect(layer.permissionRec).toBeUndefined();
  });

  it("mic failing to open → canned deny (stub behavior preserved)", async () => {
    stt.startOk = true;
    stt.startOk = false;
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    const d = decisionOf(await resolved);
    expect(d).toEqual({ behavior: "deny", message: "Denied from Conn" });
  });

  it("another key settling the decision mid-recording cancels the dictation", async () => {
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    await flush();
    expect(flow.recording).toBe(true);

    store.decide("allow"); // onQueueChanged → flow.sync()
    const d = decisionOf(await resolved);
    expect(d).toEqual({ behavior: "allow" });
    expect(flow.recording).toBe(false);
    expect(stt.cancelled).toBe(1);
    expect(layer.permissionRec).toBeUndefined();
  });

  it("the DECISION timeout mid-recording falls through to the dialog and cancels", async () => {
    store = new DecisionStore(2_000, noopLog, () => true, () => flow.sync(), "session");
    flow = new DenyReasonFlow(store, stt, layer, 10, noopLog, () => {});
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    await flush();
    expect(flow.recording).toBe(true);

    await vi.advanceTimersByTimeAsync(2_100); // decision window expires first
    expect(await resolved).toEqual({}); // normal dialog — never auto-denied
    expect(flow.recording).toBe(false);
    expect(stt.cancelled).toBe(1);
  });

  it("transcription finishing after the decision settled is discarded", async () => {
    let releaseStop!: (text: string) => void;
    stt.stop = async () => {
      stt.status = "ready";
      return new Promise<string>((r) => (releaseStop = r));
    };
    const resolved = store.hold(permissionEvent("s1"));
    flow.press();
    await flush();
    flow.press(); // stop → transcription hangs
    await flush();
    store.releaseSession("s1"); // settles {} while transcribing
    expect(await resolved).toEqual({});
    releaseStop("too late");
    await flush();
    expect(store.current).toBeUndefined(); // nothing double-resolved, no crash
  });

  it("a queued SECOND permission is untouched by the first one's dictation", async () => {
    const first = store.hold(permissionEvent("s1"));
    const second = store.hold(permissionEvent("s2"));
    flow.press();
    await flush();
    flow.press();
    const d1 = decisionOf(await first);
    expect(d1?.behavior).toBe("deny");
    // Second is now current and still pending; dictation state is clean.
    expect(store.current?.sessionId).toBe("s2");
    expect(flow.recording).toBe(false);
    store.decide("allow");
    const d2 = decisionOf(await second);
    expect(d2).toEqual({ behavior: "allow" });
  });
});
