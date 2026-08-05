import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRegistry, deriveLabel, prettifyBranch, samePath, pathWithin } from "../src/registry.js";

function start(registry: SessionRegistry, id: string, cwd = `C:\\dev\\${id}`) {
  return registry.ensure({ session_id: id, cwd, hook_event_name: "SessionStart" });
}

describe("prettifyBranch (feature name)", () => {
  it("drops the namespace prefix, trailing hash, and date; hyphens→spaces", () => {
    expect(prettifyBranch("claude/stream-deck-claude-code-736eec")).toBe("stream deck claude code");
    expect(prettifyBranch("feature/sfdc-quote-fix-2026-07-16")).toBe("sfdc quote fix");
    expect(prettifyBranch("claude/new-session-testing-0212d5")).toBe("new session testing");
    expect(prettifyBranch("bugfix/login_flow")).toBe("login flow");
  });
});

describe("deriveLabel", () => {
  it("falls back to the cwd leaf for non-git dirs", () => {
    // These temp-ish paths aren't git repos, so we get the leaf directory.
    expect(deriveLabel("C:\\nope\\not-a-repo-xyz")).toBe("not-a-repo-xyz");
    expect(deriveLabel(undefined)).toBe("session");
  });
});

describe("pathWithin (a session that wandered into a subdirectory)", () => {
  it("matches the dir itself and anything under it, case/separator-insensitively", () => {
    const root = "C:\\dev\\repo\\.claude\\worktrees\\brisk-wombat";
    expect(pathWithin(root, root)).toBe(true);
    expect(pathWithin(`${root}\\scratch\\renewal-cap-validation`, root)).toBe(true);
    expect(pathWithin(root.toUpperCase().replace(/\\/g, "/") + "/scratch", root)).toBe(true);
  });

  it("does not match siblings or prefix look-alikes", () => {
    const root = "C:\\dev\\repo\\worktrees\\brisk";
    expect(pathWithin("C:\\dev\\repo\\worktrees\\brisk-wombat", root)).toBe(false);
    expect(pathWithin("C:\\dev\\repo\\worktrees", root)).toBe(false);
  });
});

describe("provisional adoption from a subdirectory", () => {
  it("adopts a session whose cwd drifted below the launch dir (no phantom twin)", () => {
    // The live bug: the console launched in <worktree>, then reported hooks
    // from <worktree>\scratch\… — it registered as a SECOND, desktop-kind
    // session beside its own console key, labelled "<name> 2".
    const r = new SessionRegistry(5);
    const root = "C:\\dev\\repo\\.claude\\worktrees\\brisk-wombat";
    const provisionalId = r.addProvisionalAt(root).sessionId; // adoption mutates in place
    r.bindProvisional(root, { pid: 44980, hwnd: 15013890 });

    const adopted = r.ensure({
      session_id: "1b299bf2",
      cwd: `${root}\\scratch\\renewal-cap-validation`,
      hook_event_name: "UserPromptSubmit",
    });

    expect(r.all()).toHaveLength(1); // adopted in place, not duplicated
    expect(adopted.sessionId).toBe("1b299bf2");
    expect(adopted.windowKind).toBe("console"); // kept its console identity
    expect(adopted.hwnd).toBe(15013890);
    expect(adopted.pid).toBe(44980);
    expect(r.get(provisionalId)).toBeUndefined();
    expect(adopted.label).not.toMatch(/ 2$/);
  });

  it("still refuses to adopt an unrelated cwd", () => {
    const r = new SessionRegistry(5);
    r.addProvisionalAt("C:\\dev\\repo\\worktrees\\brisk-wombat");
    r.ensure({ session_id: "other", cwd: "C:\\dev\\elsewhere", hook_event_name: "SessionStart" });
    expect(r.all()).toHaveLength(2);
  });
});

describe("adopting terminal sessions the deck didn't launch", () => {
  it("binds a hand-started session to its pid and makes it a console", () => {
    const r = new SessionRegistry(5);
    const e = start(r, "s1");
    expect(e.windowKind).toBe("desktop"); // the old guess
    expect(r.adoptTerminal("s1", 36588)).toBe(true);
    expect(e.pid).toBe(36588);
    expect(e.windowKind).toBe("console"); // now speaks the TUI dialect
  });

  // This used to assert the OPPOSITE — that a deck-launched binding always
  // wins, because it carries an hwnd for focus. That assumption is what made a
  // crossed binding permanent: four `Resume` launches in the SAME cwd get
  // paired to sessions arbitrarily (cwd is the only key), and Claude Code's
  // own record — which is authoritative, since each session writes its own pid
  // — was then re-read every 30s and thrown away. Keys drove the wrong console
  // until the bridge restarted.
  it("CORRECTS a binding Claude Code disagrees with, and drops the stale hwnd", () => {
    const r = new SessionRegistry(5);
    r.registerPendingLaunch({ cwd: "C:\\dev\\x", pid: 4242, hwnd: 777, at: Date.now() });
    const e = r.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    expect(e.pid).toBe(4242);

    // Claude Code says this session is really pid 36588 — believe it.
    expect(r.adoptTerminal("s1", 36588)).toBe(true);
    expect(e.pid).toBe(36588);
    // The hwnd was paired with the OLD pid, so it belongs to a different
    // console. Dropping it lets focus re-derive from the corrected pid rather
    // than raising someone else's window.
    expect(e.hwnd).toBeUndefined();
  });

  it("is a no-op when the binding already agrees — no churn on every sweep", () => {
    const r = new SessionRegistry(5);
    const e = start(r, "s1");
    expect(r.adoptTerminal("s1", 36588)).toBe(true); // first bind
    expect(r.adoptTerminal("s1", 36588)).toBe(false); // already correct
    expect(e.pid).toBe(36588);
  });

  it("unpicks a crossed pair: two sessions launched from ONE cwd", () => {
    // The live failure: two Resumes in the same directory, so the provisional
    // keys are indistinguishable and the pids land on the wrong sessions.
    const r = new SessionRegistry(5);
    const a = r.addKnownTerminal({ sessionId: "A", pid: 111, cwd: "C:\\dev\\repo", name: "msp products" })!;
    const b = r.addKnownTerminal({ sessionId: "B", pid: 222, cwd: "C:\\dev\\repo", name: "renewal calls" })!;
    a.pid = 222; // crossed
    b.pid = 111;

    // One sweep of Claude Code's truth puts both back.
    r.adoptTerminal("A", 111);
    r.adoptTerminal("B", 222);
    expect(a.pid).toBe(111);
    expect(b.pid).toBe(222);
  });

  it("announces new sessions so they bind on arrival, not 30s later", () => {
    const r = new SessionRegistry(5);
    const seen: string[] = [];
    r.on("session-added", (entry: { sessionId: string }) => seen.push(entry.sessionId));
    start(r, "s1");
    start(r, "s2");
    r.ensure({ session_id: "s1", cwd: "C:\\dev\\s1", hook_event_name: "Stop" }); // existing → no event
    expect(seen).toEqual(["s1", "s2"]);
  });

  it("ignores an unknown session", () => {
    const r = new SessionRegistry(5);
    expect(r.adoptTerminal("nobody", 123)).toBe(false);
  });

  it("surfaces a terminal the deck has never heard from", () => {
    // Interactive sessions fire no SessionStart, so an idle one never
    // announces itself — Claude Code's metadata is the only evidence.
    const r = new SessionRegistry(5);
    const e = r.addKnownTerminal({
      sessionId: "ec2906db",
      pid: 36588,
      cwd: "C:\\dev\\repo\\.claude\\worktrees\\nimble-otter",
      name: "renewal fix",
      status: "waiting",
    })!;
    expect(e.windowKind).toBe("console");
    expect(e.pid).toBe(36588);
    expect(e.label).toBe("renewal fix");
    expect(e.status).toBe("waiting");
    expect(r.snapshot().working).toContain("ec2906db"); // it has a key
  });

  it("never displaces a session we've actually heard from", () => {
    const r = new SessionRegistry(5);
    const live = start(r, "s1");
    live.status = "thinking";
    expect(r.addKnownTerminal({ sessionId: "s1", pid: 999 })).toBeNull();
    expect(r.get("s1")?.status).toBe("thinking"); // hook-driven state untouched
    expect(r.all()).toHaveLength(1);
  });

  it("falls back to the cwd-derived label when Claude Code has no real name", () => {
    const r = new SessionRegistry(5);
    const e = r.addKnownTerminal({ sessionId: "x", pid: 1, cwd: "C:\\nope\\some-worktree" })!;
    expect(e.label).toBe("some-worktree");
  });
});

describe("duplicate label disambiguation", () => {
  it("suffixes sessions that resolve to the same feature name", () => {
    const r = new SessionRegistry(5);
    const a = r.ensure({ session_id: "s1", cwd: "C:\\nope\\same-dir", hook_event_name: "SessionStart" });
    const b = r.ensure({ session_id: "s2", cwd: "C:\\nope\\same-dir", hook_event_name: "SessionStart" });
    const c = r.ensure({ session_id: "s3", cwd: "C:\\nope\\same-dir", hook_event_name: "SessionStart" });
    expect(a.label).toBe("same-dir");
    expect(b.label).toBe("same-dir 2");
    expect(c.label).toBe("same-dir 3");
  });
});

describe("provisional launch keys (no SessionStart at interactive launch)", () => {
  const wt = "C:\\dev\\repo\\.claude\\worktrees\\amber-wombat";

  it("claims a key the instant the launch is requested, before any binding", () => {
    const r = new SessionRegistry(5);
    const p = r.addProvisionalAt(wt);
    expect(p.windowKind).toBe("console");
    expect(p.hwnd).toBeUndefined(); // nothing spawned yet
    expect(r.snapshot().working).toContain(p.sessionId);
    expect(r.targetedSession?.sessionId).toBe(p.sessionId); // New = attention there

    r.bindProvisional(wt, { pid: 4242, hwnd: 777 });
    expect(r.get(p.sessionId)?.pid).toBe(4242);
    expect(r.get(p.sessionId)?.hwnd).toBe(777);
  });

  it("is adopted in place when the real session's first hook arrives", () => {
    const r = new SessionRegistry(5);
    start(r, "existing");
    const p = r.addProvisionalAt(wt);
    const provId = p.sessionId; // adoption mutates the entry in place
    r.registerPendingLaunch({ cwd: wt, pid: 4242, hwnd: 777, at: Date.now() });
    r.bindProvisional(wt, { pid: 4242, hwnd: 777 });
    const slotBefore = r.get(provId)!.slot;

    const real = r.ensure({ session_id: "real-abc", cwd: wt.replace(/\\/g, "/"), hook_event_name: "UserPromptSubmit" });
    expect(real.slot).toBe(slotBefore); // same key, no jump
    expect(real.hwnd).toBe(777);
    expect(real.windowKind).toBe("console");
    expect(r.get(provId)).toBeUndefined(); // no duplicate under the old id
    expect(r.all().filter((s) => samePath(s.cwd, wt)).length).toBe(1);
  });

  it("does not adopt for unrelated cwds", () => {
    const r = new SessionRegistry(5);
    const p = r.addProvisionalAt(wt);
    const other = r.ensure({ session_id: "other", cwd: "C:\\dev\\elsewhere", hook_event_name: "SessionStart" });
    expect(other.sessionId).toBe("other");
    expect(r.get(p.sessionId)).toBeDefined();
  });

  it("repoints on worktree fallback and drops on spawn failure", () => {
    const r = new SessionRegistry(5);
    const p = r.addProvisionalAt(wt);
    r.repointProvisional(wt, "C:\\dev\\repo");
    expect(r.get(p.sessionId)?.cwd).toBe("C:\\dev\\repo");
    r.dropProvisional("C:\\dev\\repo");
    expect(r.get(p.sessionId)).toBeUndefined();
  });
});

describe("live label refresh (branch rename → button)", () => {
  const repo = join(tmpdir(), `conn-labelrefresh-${process.pid}`);

  beforeAll(() => {
    // A fake repo: .git dir with a HEAD file is all deriveLabel reads.
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/deck/nimble-badger\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("re-derives the label after a branch rename, without suffix flapping", () => {
    const r = new SessionRegistry(5);
    const e = r.ensure({ session_id: "s1", cwd: repo, hook_event_name: "SessionStart" });
    expect(e.label).toBe("nimble badger");

    // Rename the branch (what `git branch -m` does to HEAD).
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/deck/quote-editor-access-fix\n");
    r.refreshLabels();
    expect(e.label).toBe("quote editor access fix");
    expect(e.labelBase).toBe("quote editor access fix");

    // No-op sweep: nothing changes, suffixes don't churn.
    r.refreshLabels();
    expect(e.label).toBe("quote editor access fix");
  });

  it("keeps duplicate suffixes stable across refreshes", () => {
    const r = new SessionRegistry(5);
    const a = r.ensure({ session_id: "a", cwd: "C:\\nope\\dupe", hook_event_name: "SessionStart" });
    const b = r.ensure({ session_id: "b", cwd: "C:\\nope\\dupe", hook_event_name: "SessionStart" });
    r.refreshLabels();
    r.refreshLabels();
    expect(a.label).toBe("dupe");
    expect(b.label).toBe("dupe 2");
  });
});

describe("working-set + pager model", () => {
  function fill(r: SessionRegistry, ids: string[]) {
    for (const id of ids) start(r, id);
  }

  it("fills slots in order, auto-targets first, no pager under slotCount", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e"]);
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.pagerActive()).toBe(false);
    expect(r.targetedSession?.sessionId).toBe("a");
  });

  it("activates the pager at slotCount+1, keeping the first 4 working", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    expect(r.pagerActive()).toBe(true);
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]);
    expect(r.snapshot().overflow).toEqual(["e", "f"]);
    expect(r.bySlot(3)?.sessionId).toBe("d");
  });

  it("floats an overflow session to MRU front on activity; working never reorders", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    r.recordEvent(r.get("f")!, "PostToolUse");
    expect(r.snapshot().overflow).toEqual(["f", "e"]);
    r.recordEvent(r.get("a")!, "PostToolUse"); // working member — no reorder
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]);
  });

  it("a waiting session is NOT yanked onto the visible page", () => {
    // Auto-surfacing rearranged the page you were reading, under your thumb.
    // The Page key announces off-page attention instead (see layers).
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]); // page 1 [a,b,c,d], rest [e,f]
    r.setStatus(r.get("e")!, "waiting");
    expect(r.snapshot().working).toEqual(["a", "b", "c", "d"]);
    expect(r.snapshot().overflow).toContain("e");
  });

  it("orderedEntries is the single list row 1 pages through", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("moveToIndex inserts before the target: ABCD move A→2 = BCAD", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d"]); // no paging
    r.moveToIndex("a", 2);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["b", "c", "a", "d"]);
  });

  it("moveToIndex can pull a session across a page boundary onto page 1", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]); // page 1 [a,b,c,d], page 2 [e,f]
    r.moveToIndex("f", 0);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["f", "a", "b", "c", "d", "e"]);
    expect(r.snapshot().working).toEqual(["f", "a", "b", "c"]);
  });

  it("moveToIndex fires 'reordered' so the order can be persisted", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b"]);
    let fired = 0;
    r.on("reordered", () => fired++);
    r.moveToIndex("b", 0);
    expect(fired).toBe(1);
  });

  it("restores the saved order across a restart, keyed by cwd", () => {
    // Arrange + move.
    const a = new SessionRegistry(5);
    fill(a, ["a", "b", "c", "d"]);
    a.moveToIndex("c", 0); // → c, a, b, d
    expect(a.orderedEntries().map((s) => s.sessionId)).toEqual(["c", "a", "b", "d"]);
    const saved = a.orderedCwds(); // cwds, front-first — what gets persisted

    // "Restart": fresh registry, load the saved order, then sessions are
    // rediscovered in their ORIGINAL (a,b,c,d) order.
    const b = new SessionRegistry(5);
    b.loadOrder(saved);
    for (const id of ["a", "b", "c", "d"]) start(b, id);
    expect(b.orderedEntries().map((s) => s.sessionId)).toEqual(["c", "a", "b", "d"]);
  });

  it("a session not in the saved order lands after the remembered ones", () => {
    const b = new SessionRegistry(5);
    b.loadOrder(["C:\\dev\\c", "C:\\dev\\a"]); // only c, a remembered
    for (const id of ["a", "b", "c"]) start(b, id); // b is unknown
    expect(b.orderedEntries().map((s) => s.sessionId)).toEqual(["c", "a", "b"]);
  });

  it("caps tracked sessions at maxSessions, dropping LRU overflow", () => {
    const r = new SessionRegistry(5, 6); // cap at 6
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    start(r, "g"); // 7th → over cap → drop LRU overflow tail
    expect(r.all().length).toBe(6);
  });

  it("retargets and refills working on release of a slotted session", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]); // working [a,b,c,d], overflow [e,f]
    r.release("a");
    // pager deactivates (5 left), working refills from overflow
    expect(r.pagerActive()).toBe(false);
    expect(r.snapshot().working).toEqual(["b", "c", "d", "e", "f"]);
    expect(r.targetedSession?.sessionId).toBe("b");
  });
});

describe("sweep + wake (the Tidy key)", () => {
  it("hides a cohort by window kind, keeps them tracked, drops them off the deck", () => {
    const r = new SessionRegistry(5);
    start(r, "c1");
    r.adoptTerminal("c1", 101); // → console
    start(r, "c2");
    r.adoptTerminal("c2", 102); // → console
    start(r, "d1"); // stays desktop
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["c1", "c2", "d1"]);

    const n = r.sweep(["console"]);
    expect(n).toBe(2);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["d1"]); // consoles gone
    expect(r.get("c1")?.hidden).toBe(true);
    expect(r.all()).toHaveLength(3); // still tracked, just hidden
  });

  it("Windows sweeps desktop app tabs; All takes both", () => {
    const r = new SessionRegistry(5);
    start(r, "c1");
    r.adoptTerminal("c1", 1); // console
    start(r, "d1"); // desktop
    expect(r.sweep(["desktop"])).toBe(1);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["c1"]);
    expect(r.sweep(["console", "desktop"])).toBe(1);
    expect(r.orderedEntries()).toHaveLength(0);
  });

  it("the 30s re-scan can't drag a swept session back — it reads as known", () => {
    const r = new SessionRegistry(5);
    r.addKnownTerminal({ sessionId: "c1", pid: 101 }); // console
    r.sweep(["console"]);
    expect(r.orderedEntries()).toHaveLength(0);
    // The periodic scan re-offers the same session; it must be refused.
    expect(r.addKnownTerminal({ sessionId: "c1", pid: 101 })).toBeNull();
    expect(r.orderedEntries()).toHaveLength(0); // still hidden
  });

  it("wake un-hides and returns the session to the END of the row", () => {
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c"]) start(r, id); // desktop trio
    r.addKnownTerminal({ sessionId: "z", pid: 9 }); // console, at the end
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["a", "b", "c", "z"]);

    r.sweep(["console"]); // hide z
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["a", "b", "c"]);

    r.wake("z");
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["a", "b", "c", "z"]); // back at the end
    expect(r.get("z")?.hidden).toBeFalsy();
  });

  it("wake is a no-op for a session that isn't hidden", () => {
    const r = new SessionRegistry(5);
    start(r, "a");
    start(r, "b");
    const before = r.orderedEntries().map((s) => s.sessionId);
    r.wake("a");
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(before);
  });

  it("hidden sessions do not inflate the pager", () => {
    const r = new SessionRegistry(5);
    for (const id of ["a", "b", "c", "d", "e", "f"]) start(r, id); // 6 → pager on
    expect(r.pagerActive()).toBe(true);
    for (const id of ["c", "d", "e", "f"]) r.adoptTerminal(id, 1); // consoles
    expect(r.sweep(["console"])).toBe(4); // 2 visible left
    expect(r.pagerActive()).toBe(false);
    expect(r.orderedEntries().map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("retargets when the swept cohort included the target", () => {
    const r = new SessionRegistry(5);
    r.addKnownTerminal({ sessionId: "c", pid: 1 }); // console, auto-targeted (first)
    start(r, "d"); // desktop survivor
    r.target("c");
    expect(r.targetedSession?.sessionId).toBe("c");
    r.sweep(["console"]);
    expect(r.targetedSession?.sessionId).toBe("d");
  });

  it("never sweeps a launch in flight", () => {
    const r = new SessionRegistry(5);
    const p = r.addProvisionalAt("C:\\dev\\repo\\.claude\\worktrees\\amber"); // console-kind provisional
    expect(r.sweep(["console"])).toBe(0);
    expect(r.get(p.sessionId)?.hidden).toBeFalsy();
    expect(r.orderedEntries().map((s) => s.sessionId)).toContain(p.sessionId);
  });
});
