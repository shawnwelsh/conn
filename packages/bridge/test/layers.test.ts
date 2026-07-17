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
  newSessionWorktrees: true,
  worktreeTimeoutSeconds: 90,
  suggestionAcceptText: "yes",
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
