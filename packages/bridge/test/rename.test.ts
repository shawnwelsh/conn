import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DeckController } from "../src/controller.js";
import { SessionRegistry } from "../src/registry.js";
import { initialControls, initialRow1, initialRow2Cmd, computeTiles, type DeckLayerState } from "../src/layers.js";
import { slugifyName, isDeckBranch, renameDeckBranch } from "../src/rename.js";
import { readCcSessionNames } from "../src/sessionMeta.js";
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

describe("readCcSessionNames (Claude Code's own /rename)", () => {
  const dir = join(tmpdir(), `claude-deck-ccmeta-${process.pid}`);
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (file: string, obj: unknown) => writeFileSync(join(dir, file), JSON.stringify(obj));

  it("adopts user-given names and ignores cwd-derived filler", () => {
    write("92100.json", { pid: 92100, sessionId: "s-named", name: "Renewal Fix", status: "busy" });
    write("68060.json", { pid: 68060, sessionId: "s-derived", name: "dazzling-williams-cb6de4-18", nameSource: "derived" });
    const names = readCcSessionNames(dir);
    expect(names.get("s-named")).toBe("Renewal Fix");
    expect(names.has("s-derived")).toBe(false);
  });

  it("survives junk files and a missing directory", () => {
    write("broken.json", "not-an-object");
    writeFileSync(join(dir, "notjson.txt"), "ignored");
    writeFileSync(join(dir, "bad.json"), "{oops");
    expect(readCcSessionNames(dir).size).toBe(0);
    expect(readCcSessionNames(join(dir, "does-not-exist")).size).toBe(0);
  });
});

describe("label precedence: deck rename > /rename > branch", () => {
  it("adopts a Claude Code name, then lets a deck rename overrule it", () => {
    const r = new SessionRegistry(5);
    r.ensure({ session_id: "s1", cwd: "C:\\dev\\some-repo", hook_event_name: "SessionStart" });
    const derived = r.get("s1")!.label;

    r.refreshLabels(new Map([["s1", "Renewal Fix"]]));
    expect(r.get("s1")?.label).toBe("Renewal Fix");
    expect(r.get("s1")?.label).not.toBe(derived);

    r.setLabelOverride("s1", "hosting rework"); // triple-tap has the final say
    r.refreshLabels(new Map([["s1", "Renewal Fix"]])); // CC name still present
    expect(r.get("s1")?.label).toBe("hosting rework");
  });

  it("keeps the Claude Code name across sweeps that pass no map", () => {
    const r = new SessionRegistry(5);
    r.ensure({ session_id: "s1", cwd: "C:\\dev\\some-repo", hook_event_name: "SessionStart" });
    r.refreshLabels(new Map([["s1", "Renewal Fix"]]));
    r.refreshLabels(); // branch-only sweep must not clobber it back
    expect(r.get("s1")?.label).toBe("Renewal Fix");
  });
});

describe('"sendname" command (manual name sync)', () => {
  function setup(kind: "console" | "desktop") {
    const r = new SessionRegistry(5);
    if (kind === "console") r.registerPendingLaunch({ cwd: "C:\\dev\\x", pid: 9, hwnd: 7, at: Date.now() });
    r.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    r.setLabelOverride("s1", "hosting rework");
    const layer: DeckLayerState = {
      row1: initialRow1(), row2: "idle", row2Cmd: initialRow2Cmd(), row3Page: 0, controls: initialControls(),
    };
    const sent: string[] = [];
    const adapter = new NoopAdapter(() => {});
    adapter.sendText = async (_s, t) => { sent.push(`text:${t}`); return true; };
    adapter.sendKey = async (_s, k) => { sent.push(`key:${k}`); return true; };
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    c.setCommands({ all: () => [{ kind: "builtin", id: "sendname" }], move: () => {} });
    return { r, c, sent, layer };
  }

  it("types /rename with the button's name into a console session", async () => {
    const { c, sent } = setup("console");
    (c as any).row2(0);
    await vi.waitFor(() => expect(sent).toEqual(["text:/rename hosting rework", "key:enter"]));
  });

  it("refuses on a desktop session (would retitle the visible conversation)", async () => {
    const { c, sent } = setup("desktop");
    (c as any).row2(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
  });

  it("renders the name it would send, and greys out for desktop", () => {
    const con = setup("console");
    expect(computeTiles(con.r, con.layer, cfg, [{ kind: "builtin", id: "sendname" }], false)[5])
      .toMatchObject({ text: "Send name", subtext: "hosting rework", state: "command" });
    const desk = setup("desktop");
    expect(computeTiles(desk.r, desk.layer, cfg, [{ kind: "builtin", id: "sendname" }], false)[5])
      .toMatchObject({ text: "Send name", subtext: "console only", state: "blank" });
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
    // Simulate an earlier rename already adopted from Claude Code: this
    // outranks the branch, and a second rename must still take effect
    // IMMEDIATELY rather than waiting for the next 30s sweep.
    r.refreshLabels(new Map([["c1", "an earlier name"]]));
    expect(r.get("c1")?.label).toBe("an earlier name");

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

  it("pushes /rename into a CONSOLE session so Claude Code's name matches", async () => {
    const r = new SessionRegistry(5);
    r.registerPendingLaunch({ cwd: "C:\\dev\\not-a-repo", pid: 9, hwnd: 7, at: Date.now() });
    r.ensure({ session_id: "con", cwd: "C:\\dev\\not-a-repo", hook_event_name: "SessionStart" });
    const sent: string[] = [];
    const adapter = new NoopAdapter(() => {});
    adapter.sendText = async (_s, t) => { sent.push(`text:${t}`); return true; };
    adapter.sendKey = async (_s, k) => { sent.push(`key:${k}`); return true; };
    const c = new DeckController(r, layer, adapter, cfg, noopLog, () => {});
    c.setStt(stt);

    const tap = async () => { c.down(11); c.up(11); await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10); };
    await tap();
    await tap();
    expect(sent).toEqual(["text:/rename stream deck push to talk", "key:enter"]);
    expect(r.get("con")?.label).toBe("stream deck push to talk");
  });

  it("does NOT push /rename at a desktop session (would retitle the visible one)", async () => {
    const sent: string[] = [];
    const adapter = new NoopAdapter(() => {});
    adapter.sendText = async (_s, t) => { sent.push(t); return true; };
    const c = new DeckController(registry, layer, adapter, cfg, noopLog, () => {});
    c.setStt(stt);
    const tap = async () => { c.down(11); c.up(11); await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 10); };
    await tap();
    await tap();
    expect(sent).toEqual([]); // registry's s1 is a desktop session
    expect(registry.get("s1")?.label).toBe("stream deck push to talk"); // button still renamed
  });

  it("triple-tapping a session key starts its rename (the final override)", async () => {
    layer.row3Page = 0; // row 1 works regardless of the globals page
    const tap = () => {
      controller.down(0);
      controller.up(0);
    };
    tap();
    tap(); // double → focus fires here, harmlessly
    tap(); // triple → rename
    await vi.advanceTimersByTimeAsync(10);
    expect(stt.calls).toEqual(["start"]);
    expect(layer.renameRec).toBeDefined();

    await vi.advanceTimersByTimeAsync(10_000); // window elapses
    expect(registry.get("s1")?.label).toBe("stream deck push to talk");
  });

  it("tapping the session's own key stops the recording (no waiting for the timeout)", async () => {
    layer.row3Page = 0;
    const tap = () => { controller.down(0); controller.up(0); };
    tap(); tap(); tap(); // triple → start
    await vi.advanceTimersByTimeAsync(10);
    expect(layer.renameRec?.sessionId).toBe("s1");

    // A single tap on that same key ends it — the countdown is rendered there.
    controller.down(0);
    controller.up(0);
    await vi.advanceTimersByTimeAsync(cfg.doubleTapMs + 20);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(layer.renameRec).toBeUndefined();
    expect(registry.get("s1")?.label).toBe("stream deck push to talk");
  });

  it("tapping the blinking mic key ends the rename too", async () => {
    // The mic key renders REC for any live dictation, so it must stop this one.
    layer.row3Page = 0;
    const tap = () => { controller.down(0); controller.up(0); };
    tap(); tap(); tap(); // triple → start
    await vi.advanceTimersByTimeAsync(10);
    expect(layer.renameRec).toBeDefined();

    controller.down(10); // mic key acts on the down edge
    controller.up(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(stt.calls).toEqual(["start", "stop"]);
    expect(layer.renameRec).toBeUndefined();
    expect(registry.get("s1")?.label).toBe("stream deck push to talk");
  });

  it("the session's row-1 key becomes the countdown while listening", async () => {
    layer.row3Page = 0;
    const tap = () => { controller.down(0); controller.up(0); };
    tap(); tap(); tap();
    await vi.advanceTimersByTimeAsync(10);
    const tiles = computeTiles(registry, layer, cfg, [], true);
    expect(tiles[0]).toMatchObject({ text: "10s", state: "error", selected: true });
    expect(String(tiles[0]!.subtext)).toContain("tap to stop");
  });

  it("renders the key with the current name, then a countdown while listening", async () => {
    const before = computeTiles(registry, layer, cfg, [], false);
    expect(before[11]).toMatchObject({ text: "Rename", subtext: registry.get("s1")!.label });

    await tapRename();
    const during = computeTiles(registry, layer, cfg, [], true);
    expect(during[11]).toMatchObject({ text: "10s", state: "error", selected: true });
    expect(String(during[11]!.subtext)).toContain("renaming");
  });
});
