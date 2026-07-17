import { describe, expect, it, beforeEach } from "vitest";
import { extractSuggestion, activeSuggestion } from "../src/suggestions.js";
import { SessionRegistry } from "../src/registry.js";
import { DeckController } from "../src/controller.js";
import { initialRow1, initialRow2Cmd, initialControls, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("extractSuggestion", () => {
  it("takes the trailing question of the final paragraph", () => {
    const msg = "All 45 tests pass and the branch is pushed.\n\nThe renderer is done. Want me to also wire the plugin build into CI?";
    expect(extractSuggestion(msg)).toBe("Want me to also wire the plugin build into CI?");
  });

  it("returns null when the message doesn't end with a question", () => {
    expect(extractSuggestion("Done. Everything is committed.")).toBeNull();
    expect(extractSuggestion(undefined)).toBeNull();
    expect(extractSuggestion("")).toBeNull();
  });

  it("ignores question marks inside code blocks", () => {
    const msg = "Fixed:\n\n```\nconst x = a ? b : c;\n```\n\nCommitted and pushed.";
    expect(extractSuggestion(msg)).toBeNull();
  });

  it("strips markdown and caps very long suggestions", () => {
    const long = "Shall I " + "really ".repeat(50) + "proceed?";
    const out = extractSuggestion(long)!;
    expect(out.length).toBeLessThanOrEqual(220);
  });
});

describe("suggestion layer gating + accept", () => {
  const cfg = {
    slots: 5, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5,
    cannedCommands: {}, suggestionAcceptText: "yes",
  } as unknown as DeckConfig;

  class RecordingAdapter implements DeliveryAdapter {
    calls: string[] = [];
    async focus(): Promise<boolean> { this.calls.push("focus"); return true; }
    async sendText(_s: SessionRef, t: string): Promise<boolean> { this.calls.push(`text:${t}`); return true; }
    async sendKey(_s: SessionRef, c: string): Promise<boolean> { this.calls.push(`key:${c}`); return true; }
    async sendSequence(): Promise<boolean> { return true; }
    async findWindowByPid(): Promise<number | null> { return null; }
    async checkWindow(): Promise<boolean | null> { return null; }
    async dispose(): Promise<void> {}
  }

  let r: SessionRegistry;
  let layer: DeckLayerState;

  beforeEach(() => {
    r = new SessionRegistry(5);
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls() };
  });

  function consoleSession(id: string, suggestion?: string) {
    r.registerPendingLaunch({ cwd: `C:\\dev\\${id}`, pid: 1, hwnd: 9, at: Date.now() });
    const e = r.ensure({ session_id: id, cwd: `C:\\dev\\${id}`, hook_event_name: "SessionStart" });
    e.status = "done";
    e.suggestion = suggestion;
    return e;
  }

  it("active only for targeted, done, console sessions with a suggestion", () => {
    const e = consoleSession("c1", "Want me to continue?");
    expect(activeSuggestion(r, layer)?.text).toBe("Want me to continue?");
    e.status = "thinking";
    expect(activeSuggestion(r, layer)).toBeNull();
    e.status = "done";
    e.windowKind = "desktop"; // desktop sessions never get the accept surface
    expect(activeSuggestion(r, layer)).toBeNull();
  });

  it("Accept focuses, types the accept text, presses Enter, and consumes", async () => {
    const e = consoleSession("c1", "Want me to continue?");
    const adapter = new RecordingAdapter();
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    (c as any).row2(0);
    await flush();
    expect(adapter.calls).toEqual(["focus", "text:yes", "key:enter"]);
    expect(e.suggestion).toBeUndefined();
    expect(activeSuggestion(r, layer)).toBeNull();
  });

  it("banner keys focus the session instead of accepting", async () => {
    consoleSession("c1", "Want me to continue?");
    const adapter = new RecordingAdapter();
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    (c as any).row2(2);
    await flush();
    expect(adapter.calls).toEqual(["focus"]);
  });
});
