import { describe, expect, it, beforeEach } from "vitest";
import { extractSuggestion, activeSuggestion, isChoiceQuestion } from "../src/suggestions.js";
import { SessionRegistry } from "../src/registry.js";
import { DeckController } from "../src/controller.js";
import { initialRow1, initialRow2Cmd, initialControls, computeTiles, type DeckLayerState } from "../src/layers.js";
import type { DeckConfig } from "../src/config.js";
import type { DeliveryAdapter, SessionRef } from "../src/delivery/adapter.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const flush = () => new Promise((r) => setTimeout(r, 300)); // past the console submit gap

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

describe("isChoiceQuestion (either/or vs yes/no)", () => {
  it("spots a real choice, and leaves yes/no offers alone", () => {
    expect(isChoiceQuestion("Run that as a separate cleanup, or leave it?")).toBe(true);
    expect(isChoiceQuestion("Should I use Postgres, MySQL, or SQLite?")).toBe(true);
    expect(isChoiceQuestion("Want me to also wire the tests?")).toBe(false);
    expect(isChoiceQuestion("Should I check whether it exists or not?")).toBe(false);
    expect(isChoiceQuestion("Shall I refactor the orchestrator?")).toBe(false); // "or" inside a word
  });
});

describe("suggestion layer gating + accept", () => {
  const cfg = {
    slots: 5, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5,
    cannedCommands: {}, suggestionAcceptText: "yes",
    ptt: { enabled: true, python: "python", model: "m", language: "en", maxSeconds: 60, reasonMaxSeconds: 10, renameMaxSeconds: 10 },
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

  it("Accept types the accept text focus-free, presses Enter, and consumes", async () => {
    const e = consoleSession("c1", "Want me to continue?");
    const adapter = new RecordingAdapter();
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    (c as any).row2(0);
    await flush();
    expect(adapter.calls).toEqual(["text:yes", "key:enter"]);
    expect(e.suggestion).toBeUndefined();
    expect(activeSuggestion(r, layer)).toBeNull();
  });

  it("an either/or question takes the whole row and answers by voice", async () => {
    const e = consoleSession("c1", "Should I run that as a separate cleanup, or leave it?");
    const adapter = new RecordingAdapter();
    const stt = {
      status: "ready" as const,
      calls: [] as string[],
      async start() { this.calls.push("start"); this.status = "recording" as never; return true; },
      async stop() { this.calls.push("stop"); this.status = "ready" as never; return "run it separately"; },
      async cancel() { this.calls.push("cancel"); },
    };
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    c.setStt(stt as never);

    // No Accept key: all five keys carry the question.
    const tiles = computeTiles(r, layer, cfg, [], false);
    for (let i = 5; i <= 9; i++) {
      expect(tiles[i]).toMatchObject({ text: e.suggestion, bannerSpan: 5 });
    }
    expect(tiles.slice(5, 10).some((t) => t.text === "Accept")).toBe(false);

    // Any key talks; a second press stops and types the answer, unsent.
    (c as any).row2(2);
    await flush();
    expect(stt.calls).toEqual(["start"]);
    (c as any).row2(4);
    await flush();
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(adapter.calls).toEqual(["text:run it separately"]);
  });

  it("keeps the Accept key for a plain yes/no offer", () => {
    consoleSession("c1", "Want me to also wire the tests?");
    const tiles = computeTiles(r, layer, cfg, [], false);
    expect(tiles[5]).toMatchObject({ text: "Accept" });
    expect(tiles[6]).toMatchObject({ bannerSpan: 4 });
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
