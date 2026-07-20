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

  it("never overwrites a deck-launched binding", () => {
    const r = new SessionRegistry(5);
    r.registerPendingLaunch({ cwd: "C:\\dev\\x", pid: 4242, hwnd: 777, at: Date.now() });
    const e = r.ensure({ session_id: "s1", cwd: "C:\\dev\\x", hook_event_name: "SessionStart" });
    expect(e.pid).toBe(4242);
    // The deck-launched binding also carries an hwnd for focus — strictly
    // better than what adoption can offer, so it wins.
    expect(r.adoptTerminal("s1", 36588)).toBe(false);
    expect(e.pid).toBe(4242);
    expect(e.hwnd).toBe(777);
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
  const repo = join(tmpdir(), `belay-labelrefresh-${process.pid}`);

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

  it("surfaces a single waiting overflow session into slot #4", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]); // working [a,b,c,d], overflow [e,f]
    r.setStatus(r.get("e")!, "waiting");
    expect(r.snapshot().working).toEqual(["a", "b", "c", "e"]);
    expect(r.snapshot().overflow).toContain("d");
    expect(r.pagerFlashing()).toBe(false);
  });

  it("flashes the pager when a second overflow session needs attention", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f", "g"]); // working [a,b,c,d], overflow [e,f,g]
    r.setStatus(r.get("e")!, "waiting"); // surfaces e → slot 3
    r.setStatus(r.get("f")!, "waiting"); // slot 3 busy → flash
    expect(r.pagerFlashing()).toBe(true);
    expect(r.snapshot().working).toContain("e"); // e stayed surfaced
    expect(r.snapshot().overflow).toContain("f");
    // Resolving the overflow waiter clears the flash.
    r.setStatus(r.get("f")!, "thinking");
    expect(r.pagerFlashing()).toBe(false);
  });

  it("promoteToFront brings a session to slot #1 and shifts the rest", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d", "e", "f"]);
    r.promoteToFront("f");
    expect(r.snapshot().working).toEqual(["f", "a", "b", "c"]);
    expect(r.snapshot().overflow).toContain("d");
    expect(r.targetedSession?.sessionId).toBe("f");
  });

  it("moveToSlot inserts before the target: ABCD move A→2 = BCAD", () => {
    const r = new SessionRegistry(5);
    fill(r, ["a", "b", "c", "d"]); // working [a,b,c,d], no pager
    r.moveToSlot("a", 2);
    expect(r.snapshot().working).toEqual(["b", "c", "a", "d"]);
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
