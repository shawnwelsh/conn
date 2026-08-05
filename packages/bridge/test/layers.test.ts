import { describe, expect, it } from "vitest";
import { advanceQuestion, computeTiles, targetAfterInterrupt, type DeckLayerState } from "../src/layers.js";
import { SessionRegistry } from "../src/registry.js";
import type { DeckConfig } from "../src/config.js";

const cfg: DeckConfig = {
  port: 3711,
  decisionTimeoutSeconds: 30,
  slots: 5,
  maxSessions: 15,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  cmdPagerRevertSeconds: 6,
  staleSessionMinutes: 60,
  deadSessionSweepHours: 3,
  alwaysAllowDestination: "session",
  delivery: { adapter: "noop", ahkPath: "", windowMode: "activeWindow" },
  commandsFile: "commands.json",
  newSessionCommand: "claude",
  consoleHost: "wt",
  newSessionWorktrees: true,
  worktreeTimeoutSeconds: 90,
  suggestionAcceptText: "yes",
  desktopSubmitDelayMs: 250,
  ptt: { enabled: false, python: "python", model: "distil-small.en", language: "en", maxSeconds: 60, reasonMaxSeconds: 10, renameMaxSeconds: 10 },
  optionReader: { enabled: false, model: "haiku", timeoutSeconds: 20 },
  log: { level: "info", dir: "logs" },
};

function start(r: SessionRegistry, id: string) {
  return r.ensure({ session_id: id, cwd: `C:\\dev\\${id}`, hook_event_name: "SessionStart" });
}

describe("target restore after an interrupt morph (permission or question)", () => {
  // You're working in A; an interrupt from B takes over the deck and retargets
  // to B so the answer keys act on it. Once handled, the target must return to
  // A — an interruption should cost one answer, not an answer plus a re-select.
  // `alive` is the set of sessions that still exist.
  const alive = (...ids: string[]) => (id: string) => ids.includes(id);

  it("returns focus to the session you were working in before the interrupt", () => {
    expect(targetAfterInterrupt("A", "B", alive("A", "B"))).toBe("A");
  });

  it("does nothing when the origin is already the current target", () => {
    // The interrupt came from the very session you were on (B asked, or the
    // whole stack unwound back to B): answering leaves you on B.
    expect(targetAfterInterrupt("B", "B", alive("B"))).toBeNull();
  });

  it("does nothing when nothing was targeted before the interrupt", () => {
    expect(targetAfterInterrupt(undefined, "B", alive("B"))).toBeNull();
  });

  it("does not resurrect an origin session that has since died", () => {
    // A ended while you were answering B's interrupt — leave the target on B
    // rather than pointing at a session that no longer exists.
    expect(targetAfterInterrupt("A", "B", alive("B"))).toBeNull();
  });
});

// An MCP elicitation ("Are you sure you want to execute dax queries…?") raises
// NO hook, so the deck can't offer buttons for it — but the session is stuck.
// The slow breath says "come and look" without borrowing the one visual that
// means "your keystrokes land here".
describe("row-1 slow pulse for a session blocked at an unanswerable prompt", () => {
  const agents = (): DeckLayerState => ({
    row1: { mode: "agents", page: 0 },
    row2: "idle",
    row2Cmd: { mode: "default", page: 0 },
    row3Page: 0,
    controls: { planNext: "plan", modelNext: 1 },
  });

  it("breathes a waiting session on the SLOW clock, not the 2Hz flash", () => {
    const r = new SessionRegistry(5);
    const a = start(r, "a");
    const stuck = start(r, "stuck");
    r.target(a.sessionId);
    r.setStatus(stuck, "waiting");

    // slowPhase is the 6th argument; flashPhase (5th) must not drive it.
    const lit = computeTiles(r, agents(), cfg, [], false, true);
    const dark = computeTiles(r, agents(), cfg, [], false, false);
    expect(lit[stuck.slot]!.pulse).toBe(true);
    expect(dark[stuck.slot]!.pulse).toBe(false);
    // The fast clock alone never pulses it.
    expect(computeTiles(r, agents(), cfg, [], true, false)[stuck.slot]!.pulse).toBe(false);
  });

  it("stays veiled while breathing — it must not look like the targeted console", () => {
    // Full brightness means "keystrokes go here". A key that borrows that look
    // to ask for attention is how input lands in the wrong window.
    const r = new SessionRegistry(5);
    const a = start(r, "a");
    const stuck = start(r, "stuck");
    r.target(a.sessionId);
    r.setStatus(stuck, "waiting");
    const tiles = computeTiles(r, agents(), cfg, [], false, true);
    expect(tiles[stuck.slot]!.veil).toBe(true); // still receded
    expect(tiles[a.slot]!.veil).toBe(false); // the target stays the bright one
    expect(tiles[a.slot]!.pulse).toBe(false); // and doesn't breathe
  });

  it("leaves settled sessions alone", () => {
    const r = new SessionRegistry(5);
    const a = start(r, "a");
    const b = start(r, "b");
    r.setStatus(b, "thinking");
    const tiles = computeTiles(r, agents(), cfg, [], false, true);
    expect(tiles[a.slot]!.pulse).toBe(false);
    expect(tiles[b.slot]!.pulse).toBe(false);
  });
});

describe("row-1 stale dimming", () => {
  it("dims a slot with no events past the threshold, keeps fresh ones lit", () => {
    const r = new SessionRegistry(5);
    const fresh = start(r, "fresh");
    const stale = start(r, "stale");
    stale.lastEventAt = Date.now() - 61 * 60_000; // 61 min ago

    const layer: DeckLayerState = {
      row1: { mode: "agents", page: 0 },
      row2: "idle",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      controls: { planNext: "plan", modelNext: 1 },
    };
    const tiles = computeTiles(r, layer, cfg);

    expect(tiles[fresh.slot]!.dim).toBeFalsy();
    expect(tiles[stale.slot]!.dim).toBe(true);
  });

  it("lifts a TARGETED idle session to a bright state so it stands out", () => {
    // Idle's slate bg is nearly indistinguishable from a veiled thinking
    // neighbour (dark navy). The one you're driving needs to win.
    const r = new SessionRegistry(5);
    const a = start(r, "a");
    const b = start(r, "b");
    r.setStatus(a, "idle");
    r.setStatus(b, "idle");
    r.target("a");
    const layer: DeckLayerState = {
      row1: { mode: "agents", page: 0 },
      row2: "idle",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      controls: { planNext: "plan", modelNext: 1 },
    };
    const tiles = computeTiles(r, layer, cfg);
    expect(tiles[a.slot]!.state).toBe("idleActive"); // targeted → lifted
    expect(tiles[b.slot]!.state).toBe("idle"); // the rest stay plain (and veiled)
    expect(tiles[b.slot]!.veil).toBe(true);
  });

  it("only lifts idle — a busy targeted session keeps its own status colour", () => {
    const r = new SessionRegistry(5);
    const a = start(r, "a");
    r.setStatus(a, "thinking");
    r.target("a");
    const layer: DeckLayerState = {
      row1: { mode: "agents", page: 0 },
      row2: "idle",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      controls: { planNext: "plan", modelNext: 1 },
    };
    expect(computeTiles(r, layer, cfg)[a.slot]!.state).toBe("thinking");
  });

  it("never dims the session holding an active permission morph", () => {
    const r = new SessionRegistry(5);
    const s = start(r, "asking");
    s.lastEventAt = Date.now() - 120 * 60_000; // very old
    const layer: DeckLayerState = {
      row1: { mode: "agents", page: 0 },
      row2: "permission",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      permission: { sessionId: "asking", toolName: "Bash", summary: "echo x" },
      controls: { planNext: "plan", modelNext: 1 },
    };
    const tiles = computeTiles(r, layer, cfg);
    expect(tiles[s.slot]!.dim).toBeFalsy();
  });
});

describe("row-1 paging", () => {
  function agentsLayer(page = 0): DeckLayerState {
    return {
      row1: { mode: "agents", page },
      row2: "idle",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      controls: { planNext: "plan", modelNext: 1 },
    };
  }

  it("uses all five keys for sessions when they all fit", () => {
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c", "d", "e"]) start(r, id);
    const tiles = computeTiles(r, agentsLayer(), cfg);
    expect(tiles.slice(0, 5).map((t) => t.text)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("hands the last key to Page once there are more, with the paging icon", () => {
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c", "d", "e", "f"]) start(r, id);
    const tiles = computeTiles(r, agentsLayer(), cfg);
    expect(tiles.slice(0, 4).map((t) => t.text)).toEqual(["a", "b", "c", "d"]);
    expect(tiles[4]!.text).toBe("Page");
    expect(tiles[4]!.icon).toBe("page"); // matches the row-2/row-3 paging keys
    expect(tiles[4]!.subtext).toBe("1/2");
    expect(tiles[4]!.state).toBe("command");
  });

  it("page 2 shows the remainder", () => {
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c", "d", "e", "f"]) start(r, id);
    const tiles = computeTiles(r, agentsLayer(1), cfg);
    expect(tiles[0]!.text).toBe("e");
    expect(tiles[1]!.text).toBe("f");
    expect(tiles[2]!.state).toBe("blank");
  });

  it("the Page key goes yellow and counts sessions waiting on another page", () => {
    // This REPLACES auto-surfacing: nothing jumps onto your page, so the key
    // has to say that someone off-page needs you.
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c", "d", "e", "f"]) start(r, id);
    r.setStatus(r.get("e")!, "waiting");
    r.setStatus(r.get("f")!, "waiting");
    const tiles = computeTiles(r, agentsLayer(0), cfg);
    expect(tiles[4]!.state).toBe("waiting");
    expect(tiles[4]!.badge).toBe("2");
    expect(tiles[4]!.subtext).toBe("2 waiting");
  });

  it("stays calm about a waiting session you can already see", () => {
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c", "d", "e", "f"]) start(r, id);
    r.setStatus(r.get("a")!, "waiting"); // on page 1, visible
    const tiles = computeTiles(r, agentsLayer(0), cfg);
    expect(tiles[4]!.state).toBe("command");
    expect(tiles[4]!.badge).toBeUndefined();
  });
});

describe("permission panel legibility", () => {
  function questionLayer(questions: string[]): DeckLayerState {
    return {
      row1: { mode: "agents", page: 0 },
      row2: "question",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      question: {
        sessionId: "asking",
        questions: questions.map((q) => ({ question: q, options: ["Yes", "No"] })),
        index: 0,
        page: 0,
      },
      controls: { planNext: "plan", modelNext: 1 },
    };
  }

  function permLayer(permission: NonNullable<DeckLayerState["permission"]>): DeckLayerState {
    return {
      row1: { mode: "agents", page: 0 },
      row2: "permission",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      permission,
      controls: { planNext: "plan", modelNext: 1 },
    };
  }

  it("counts down to the hand-back so the panel never just vanishes", () => {
    const r = new SessionRegistry(5);
    start(r, "asking");
    const tiles = computeTiles(
      r,
      permLayer({ sessionId: "asking", toolName: "Bash", summary: "echo x", expiresAt: Date.now() + 12_600 }),
      cfg,
    );
    // Key 9 = "Show on screen" — the countdown is a countdown to exactly that.
    expect(tiles[9]!.text).toBe("Show on screen");
    expect(tiles[9]!.subtext).toMatch(/^auto 1[23]s$/);
  });

  it("shows the backlog when a session and its subagent both ask at once", () => {
    const r = new SessionRegistry(5);
    start(r, "asking");
    const tiles = computeTiles(
      r,
      permLayer({ sessionId: "asking", toolName: "Bash", summary: "echo x", depth: 2 }),
      cfg,
    );
    expect(tiles[5]!.text).toBe("Allow");
    expect(tiles[5]!.badge).toBe("2");
    // The count belongs on the asking session's key; the command itself has a
    // banner now and no longer has to fit in a 144px subtext.
    expect(tiles[0]!.subtext).toBe("2 pending");
  });

  it("banners WHAT is being approved across row 1 keys 2-5", () => {
    // The whole point of the morph is deciding, and you cannot decide what you
    // cannot read. Key 1 keeps the asking session; the rest is one wide image.
    const r = new SessionRegistry(5);
    start(r, "asking");
    start(r, "other");
    const tiles = computeTiles(
      r,
      permLayer({
        sessionId: "asking",
        toolName: "Bash",
        summary: 'cd "C:/dev/revops-platform/.claude/worktrees/quiet-vole" && npm run build',
        depth: 1,
      }),
      cfg,
    );
    expect(tiles[0]!.text).toBe("asking");
    for (let i = 1; i <= 4; i++) {
      expect(tiles[i]!.bannerSpan).toBe(4);
      expect(tiles[i]!.bannerIndex).toBe(i - 1);
      expect(tiles[i]!.text).toContain("npm run build");
      expect(tiles[i]!.text).toContain("Bash");
    }
  });

  it("banners the question text too — same problem, same fix", () => {
    const r = new SessionRegistry(5);
    start(r, "asking");
    const tiles = computeTiles(r, questionLayer(["Which store should the always-allow rule be written to?"]), cfg);
    expect(tiles[0]!.text).toBe("asking");
    expect(tiles[1]!.bannerSpan).toBe(4);
    expect(tiles[1]!.text).toContain("always-allow rule");
  });

  it("says which of several questions you are on", () => {
    // AskUserQuestion routinely carries 2-4 questions in ONE call — 14 of 21
    // calls in the real log did. Answering one and reverting abandoned the
    // rest, so the banner has to say there are more coming.
    const r = new SessionRegistry(5);
    start(r, "asking");
    const layer = questionLayer(["First thing?", "Second thing?", "Third thing?"]);
    layer.question!.index = 1;
    const tiles = computeTiles(r, layer, cfg);
    expect(tiles[1]!.text).toContain("Second thing?");
    expect(tiles[1]!.text).toContain("2/3");
    expect(tiles[0]!.subtext).toBe("2 of 3");
  });

  it("walks every question in the ask before letting the layer go", () => {
    const q = {
      sessionId: "asking",
      questions: [
        { question: "one?", options: ["a", "b"] },
        { question: "two?", options: ["c", "d"] },
        { question: "three?", options: ["e", "f"] },
      ],
      index: 0,
      page: 2, // deep in the option pager of question 1
    };
    expect(advanceQuestion(q)).toBe(true);
    expect(q.index).toBe(1);
    expect(q.page).toBe(0); // fresh question, fresh option page
    expect(advanceQuestion(q)).toBe(true);
    expect(q.index).toBe(2);
    // Last one: false tells the caller to revert rather than sit on a
    // question that no longer exists.
    expect(advanceQuestion(q)).toBe(false);
    expect(q.index).toBe(2);
  });

  it("a single-question ask reverts immediately", () => {
    const q = { sessionId: "s", questions: [{ question: "one?", options: ["a"] }], index: 0, page: 0 };
    expect(advanceQuestion(q)).toBe(false);
  });

  it("does not clutter a single-question ask with counters", () => {
    const r = new SessionRegistry(5);
    start(r, "asking");
    const tiles = computeTiles(r, questionLayer(["Only thing?"]), cfg);
    expect(tiles[1]!.text).toBe("Only thing?");
    expect(tiles[0]!.subtext).toBeUndefined();
  });

  it("a plan approval is not a tool permission", () => {
    // ExitPlanMode arrives through PermissionRequest, but "Always allow" is
    // meaningless for a plan and "Allow/Deny" is the wrong vocabulary. Key
    // POSITIONS stay put so muscle memory survives: 0 affirmative, 2 negative,
    // 3 negative-with-dictated-reason, 4 hand back to the screen.
    const r = new SessionRegistry(5);
    start(r, "asking");
    const tiles = computeTiles(
      r,
      permLayer({ sessionId: "asking", toolName: "ExitPlanMode", summary: "{}", depth: 1 }),
      cfg,
    );
    expect(tiles[5]!.text).toBe("Approve plan");
    expect(tiles[6]!.state).toBe("blank"); // no "always allow" for a plan
    expect(tiles[7]!.text).toBe("Keep planning");
    expect(tiles[8]!.text).toBe("Keep planning");
    expect(tiles[8]!.icon).toBe("mic");
    expect(tiles[9]!.text).toBe("Show on screen");
  });

  it("stays quiet when only one request is in flight", () => {
    const r = new SessionRegistry(5);
    const s = start(r, "asking");
    const tiles = computeTiles(r, permLayer({ sessionId: "asking", toolName: "Bash", summary: "echo x", depth: 1 }), cfg);
    expect(tiles[5]!.badge).toBeUndefined();
    expect(tiles[s.slot]!.subtext).toBeUndefined();
  });
});
