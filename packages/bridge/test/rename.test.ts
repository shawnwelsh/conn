import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, initialRow2Cmd, computeTiles, type DeckLayerState } from "../src/layers.js";
import { slugifyName, isDeckBranch, renameDeckBranch } from "../src/rename.js";
import type { DeckConfig } from "../src/config.js";
import { NoopAdapter } from "../src/delivery/adapter.js";
import type { SttEngine, SttStatus } from "../src/stt/sidecar.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;
const cfg = {
  slots: 5,
  doubleTapMs: 300,
  longPressMs: 500,
  moveCancelSeconds: 5,
  staleSessionMinutes: 60,
  ptt: { enabled: true, python: "python", model: "m", language: "en", maxSeconds: 60, reasonMaxSeconds: 10, renameMaxSeconds: 10 },
} as unknown as DeckConfig;

class StubStt implements SttEngine {
  status: SttStatus = "ready";
  calls: string[] = [];
  text = "stream deck push to talk";
  async ensureStarted(): Promise<void> { this.calls.push("ensureStarted"); }
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
  async cancel(): Promise<void> { this.calls.push("cancel"); this.status = "ready"; }
}

describe("slugifyName (whisper prose → branch slug + label)", () => {
  it("normalizes punctuation, case, and spacing", () => {
    expect(slugifyName("Stream deck push to talk.")).toEqual({
      label: "stream deck push to talk",
      slug: "stream-deck-push-to-talk",
    });
    expect(slugifyName("  Fix   the CPQ renewal bug! ")).toEqual({
      label: "fix the cpq renewal bug",
      slug: "fix-the-cpq-renewal-bug",
    });
  });

  it("caps a rambling take at 8 words", () => {
    const named = slugifyName("one two three four five six seven eight nine ten");
    expect(named?.slug).toBe("one-two-three-four-five-six-seven-eight");
  });

  it("returns null when nothing usable survives", () => {
    expect(slugifyName("")).toBeNull();
    expect(slugifyName("   ")).toBeNull();
    expect(slugifyName("!!! ??? ...")).toBeNull();
  });
});

describe("isDeckBranch (only rewrite branches we created)", () => {
  it("accepts deck/ branches, refuses everything else", () => {
    expect(isDeckBranch("deck/brisk-wombat")).toBe(true);
    expect(isDeckBranch("claude/stream-deck-736eec")).toBe(false);
    expect(isDeckBranch("main")).toBe(false);
    expect(isDeckBranch(null)).toBe(false);
  });
});

describe("renameDeckBranch (real git)", () => {
  const repo = join(tmpdir(), `claude-deck-rename-${process.pid}`);
  beforeEach(() => {
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "seed");
    git("checkout", "-q", "-b", "deck/brisk-wombat");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("renames the checked-out branch so label derivation follows", async () => {
    const ok = await renameDeckBranch(repo, "deck/brisk-wombat", "deck/stream-deck-ptt", noopLog);
    expect(ok).toBe(true);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    expect(head).toBe("deck/stream-deck-ptt");
  });

  it("reports failure instead of throwing when the branch is missing", async () => {
    expect(await renameDeckBranch(repo, "deck/nope", "deck/whatever", noopLog)).toBe(false);
  });
});

describe("Rename key (globals page 2)", () => {
  let registry: SessionRegistry;
  let layer: DeckLayerState;
  let stt: StubStt;
  let controller: DeckController;
  let renamed: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionRegistry(5);
    registry.ensure({ session_id: "s1", cwd: "C:\\dev\\not-a-repo", hook_event_name: "SessionStart" });
    layer = { row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 1, controls: initialControls() };
    stt = new StubStt();
    controller = new DeckController(registry, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
    controller.setStt(stt);
    renamed = [];
    controller.setOnSessionRenamed((s) => renamed.push(s.label));
  });
  afterEach(() => vi.useRealTimers());

  /** Tap the Rename key (row 3, index 1 → slot 11) on globals page 2. */
  async function tapRename() {
    controller.down(11);
    controller.up(11);
    await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10);
  }

  it("tap records, tap again names the session (non-deck cwd → override)", async () => {
    await tapRename();
    expect(stt.calls).toEqual(["start"]);
    expect(layer.renameRec).toBeDefined();

    await tapRename();
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(registry.get("s1")?.label).toBe("stream deck push to talk");
    expect(registry.get("s1")?.labelOverride).toBe("stream deck push to talk");
    expect(renamed).toEqual(["stream deck push to talk"]); // persisted via hook
    expect(layer.renameRec).toBeUndefined();
  });

  it("an override survives the label refresh sweep", async () => {
    await tapRename();
    await tapRename();
    registry.refreshLabels(); // would re-derive from cwd/branch
    expect(registry.get("s1")?.label).toBe("stream deck push to talk");
  });

  it("the window elapsing applies the name too", async () => {
    await tapRename();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(registry.get("s1")?.label).toBe("stream deck push to talk");
  });

  it("an unusable transcription leaves the name alone", async () => {
    stt.text = "  ... ";
    const before = registry.get("s1")!.label;
    await tapRename();
    await tapRename();
    expect(registry.get("s1")?.label).toBe(before);
    expect(registry.get("s1")?.labelOverride).toBeUndefined();
    expect(renamed).toEqual([]);
  });

  it("does nothing without a targeted session", async () => {
    const empty = new SessionRegistry(5);
    const c = new DeckController(empty, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
    c.setStt(stt);
    c.down(11);
    c.up(11);
    await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10);
    expect(stt.calls).toEqual([]);
  });

  it("won't grab the mic while another dictation owns it", async () => {
    stt.status = "recording"; // PTT or deny-reason in flight
    await tapRename();
    expect(stt.calls).toEqual([]);
  });

  it("renames the deck BRANCH when the session owns one — the PR gets the name too", async () => {
    // The whole point: deck/<codename> is what lands on the pull request, so
    // a rename has to rewrite the branch, not just paint the button.
    // Real timers: this drives a real git subprocess, and fake ones would
    // fire renameDeckBranch's own kill-timeout before git could finish.
    vi.useRealTimers();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const repo = join(tmpdir(), `claude-deck-rename-e2e-${process.pid}`);
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "seed");
    git("checkout", "-q", "-b", "deck/brisk-wombat");

    const r = new SessionRegistry(5);
    r.ensure({ session_id: "c1", cwd: repo, hook_event_name: "SessionStart" });
    expect(r.get("c1")?.label).toBe("brisk wombat"); // derived from the branch

    const c = new DeckController(r, layer, new NoopAdapter(() => {}), cfg, noopLog, () => {});
    c.setStt(stt);
    const seen: string[] = [];
    c.setOnSessionRenamed((s) => seen.push(s.label));

    const tap = async () => {
      c.down(11);
      c.up(11);
      await sleep(cfg.doubleTapMs + 40); // let the recognizer resolve the tap
    };
    await tap(); // start listening
    await tap(); // stop → transcribe → rename the branch

    // Poll the LABEL: it only lands after git exits AND the controller's
    // refresh re-derives from the new HEAD — asserting on git alone races it.
    await vi.waitFor(() => expect(r.get("c1")?.label).toBe("stream deck push to talk"), {
      timeout: 20_000,
      interval: 250,
    });
    const head = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    expect(head).toBe("deck/stream-deck-push-to-talk");
    expect(r.get("c1")?.labelOverride).toBeUndefined(); // branch carries it
    expect(seen).toEqual([]); // nothing to persist — the branch IS the name
    rmSync(repo, { recursive: true, force: true });
  }, 30_000);

  it("renders the key with the current name, then a countdown while listening", async () => {
    const before = computeTiles(registry, layer, cfg, [], false);
    expect(before[11]).toMatchObject({ text: "Rename", subtext: registry.get("s1")!.label });

    await tapRename();
    const during = computeTiles(registry, layer, cfg, [], true);
    expect(during[11]).toMatchObject({ text: "10s", state: "error", selected: true });
    expect(String(during[11]!.subtext)).toContain("renaming");
  });
});
