import { describe, expect, it, beforeEach } from "vitest";
import { extractSuggestion, activeSuggestion, needsSpokenAnswer } from "../src/suggestions.js";
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

describe("needsSpokenAnswer (can a canned 'yes' answer this?)", () => {
  it("spots a real choice, and leaves yes/no offers alone", () => {
    expect(needsSpokenAnswer("Run that as a separate cleanup, or leave it?")).toBe(true);
    expect(needsSpokenAnswer("Should I use Postgres, MySQL, or SQLite?")).toBe(true);
    expect(needsSpokenAnswer("Want me to also wire the tests?")).toBe(false);
    expect(needsSpokenAnswer("Should I check whether it exists or not?")).toBe(false);
    expect(needsSpokenAnswer("Shall I refactor the orchestrator?")).toBe(false); // "or" inside a word
  });

  it("an open question is not a yes/no, even with no 'or' in it", () => {
    // Both verbatim from bridge.log. The deck offered "Yes" to each, which
    // answers neither — "yes" is not a list of fields.
    expect(needsSpokenAnswer("Which context fields do you want in the line?")).toBe(true);
    expect(needsSpokenAnswer("So: which fields are we cloning the pattern for?")).toBe(true);
    expect(needsSpokenAnswer("What should the threshold be?")).toBe(true);
    expect(needsSpokenAnswer("How far back should the batch recompute?")).toBe(true);
    expect(needsSpokenAnswer("Who owns that decision?")).toBe(true);
    expect(needsSpokenAnswer("Where should the rule live?")).toBe(true);
  });

  it("keeps the Accept key when a wh-word is only buried inside an offer", () => {
    // These ARE answerable by "yes" — the wh-word is a subordinate clause,
    // not the ask. Matching wh-words anywhere would break every one of them.
    expect(needsSpokenAnswer("Want me to check what changed?")).toBe(false);
    expect(needsSpokenAnswer("Shall I document how it works?")).toBe(false);
    expect(needsSpokenAnswer("Should I look at which tests cover it?")).toBe(false);
  });
});

describe("suggestion layer gating + accept", () => {
  const cfg = {
    slots: 5, desktopJumpSettleMs: 0, doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5,
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

  it("prose options become one key each, and the press sends the label", async () => {
    // The reader found three courses of action in the message's own words.
    const e = consoleSession("c1", "Which way do you want it?");
    e.suggestionOptions = {
      question: "How should we handle the Japan gap?",
      options: ["Add Japan regional rule", "Widen APAC gate", "Defer the decision"],
    };
    const tiles = computeTiles(r, layer, cfg);
    expect(tiles.slice(5, 8).map((t) => t.text)).toEqual([
      "Add Japan regional rule",
      "Widen APAC gate",
      "Defer the decision",
    ]);
    expect(tiles[8]!.state).toBe("blank"); // only three offered
    expect(tiles[9]!.text).toBe("Talk"); // voice still available

    const adapter = new RecordingAdapter();
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    (c as any).row2(1);
    await flush();
    // The LABEL, not "2": a bare index means nothing unless the session
    // happened to print that numbering.
    expect(adapter.calls).toEqual(["text:Widen APAC gate", "key:enter"]);
    expect(e.suggestion).toBeUndefined();
  });

  it("an un-compressible choice offers to open the window instead of faking buttons", async () => {
    const e = consoleSession("c1", "Which way do you want it?");
    e.suggestionOptions = {
      question: "Three routes, each with different rollback exposure",
      options: [],
      viewInWindow: true,
    };
    const tiles = computeTiles(r, layer, cfg);
    expect(tiles[5]!.text).toBe("View in window");
    expect(tiles[6]!.bannerSpan).toBe(4);
    expect(tiles[6]!.text).toContain("rollback exposure");

    const adapter = new RecordingAdapter();
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    (c as any).row2(0);
    await flush();
    // Focus only — nothing is typed, because no answer was chosen.
    expect(adapter.calls).toEqual(["focus"]);
    expect(e.suggestion).toBe("Which way do you want it?");
  });

  it("says it is reading, so keys arriving ~10s later are not a surprise", () => {
    const e = consoleSession("c1", "Patch the flow, or add a rule?");
    e.optionsPending = true;
    const tiles = computeTiles(r, layer, cfg);
    expect(tiles[5]!.text).toContain("reading for options");
    e.optionsPending = false;
    expect(computeTiles(r, layer, cfg)[5]!.text).not.toContain("reading for options");
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

  it("lights the mic key as 'Answer' when voice is the only reply", () => {
    // The gap the user hit: the either/or banner gave no cue that talking was
    // the next step. The row-3 mic key (tile 10) now says so.
    consoleSession("c1", "Should I run that as a separate cleanup, or leave it?");
    layer.ptt = "ready";
    const tiles = computeTiles(r, layer, cfg, [], false);
    expect(tiles[10]).toMatchObject({ text: "Answer", subtext: "say your pick", state: "waiting", icon: "mic" });
  });

  it("leaves the mic key as plain Talk for a yes/no offer (Accept covers it)", () => {
    consoleSession("c1", "Want me to also wire the tests?");
    layer.ptt = "ready";
    expect(computeTiles(r, layer, cfg, [], false)[10]).toMatchObject({ text: "Talk", state: "command" });
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
