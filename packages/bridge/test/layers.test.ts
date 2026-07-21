import { describe, expect, it } from "vitest";
import { computeTiles, type DeckLayerState } from "../src/layers.js";
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
  log: { level: "info", dir: "logs" },
};

function start(r: SessionRegistry, id: string) {
  return r.ensure({ session_id: id, cwd: `C:\\dev\\${id}`, hook_event_name: "SessionStart" });
}

describe("row-1 stale dimming", () => {
  it("dims a slot with no events past the threshold, keeps fresh ones lit", () => {
    const r = new SessionRegistry(5);
    const fresh = start(r, "fresh");
    const stale = start(r, "stale");
    stale.lastEventAt = Date.now() - 61 * 60_000; // 61 min ago

    const layer: DeckLayerState = {
      row1: { mode: "agents", pagerPage: 0 },
      row2: "idle",
      row2Cmd: { mode: "default", page: 0 },
      row3Page: 0,
      controls: { planNext: "plan", modelNext: 1 },
    };
    const tiles = computeTiles(r, layer, cfg);

    expect(tiles[fresh.slot]!.dim).toBeFalsy();
    expect(tiles[stale.slot]!.dim).toBe(true);
  });

  it("never dims the session holding an active permission morph", () => {
    const r = new SessionRegistry(5);
    const s = start(r, "asking");
    s.lastEventAt = Date.now() - 120 * 60_000; // very old
    const layer: DeckLayerState = {
      row1: { mode: "agents", pagerPage: 0 },
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

describe("permission panel legibility", () => {
  function permLayer(permission: NonNullable<DeckLayerState["permission"]>): DeckLayerState {
    return {
      row1: { mode: "agents", pagerPage: 0 },
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
    const s = start(r, "asking");
    const tiles = computeTiles(
      r,
      permLayer({ sessionId: "asking", toolName: "Bash", summary: "echo x", depth: 2 }),
      cfg,
    );
    expect(tiles[5]!.text).toBe("Allow");
    expect(tiles[5]!.badge).toBe("2");
    expect(tiles[s.slot]!.subtext).toBe("2 pending · Bash: echo x");
  });

  it("stays quiet when only one request is in flight", () => {
    const r = new SessionRegistry(5);
    const s = start(r, "asking");
    const tiles = computeTiles(r, permLayer({ sessionId: "asking", toolName: "Bash", summary: "echo x", depth: 1 }), cfg);
    expect(tiles[5]!.badge).toBeUndefined();
    expect(tiles[s.slot]!.subtext).toBe("Bash: echo x");
  });
});
