import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findRepoRoot, ConsoleLauncher } from "../src/delivery/launcher.js";

const fixture = join(tmpdir(), `conn-launcher-test-${process.pid}`);

beforeAll(() => {
  // mainrepo/.git/ (dir) with a worktree at mainrepo/.claude/worktrees/wt
  mkdirSync(join(fixture, "mainrepo", ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(join(fixture, "mainrepo", "src", "deep"), { recursive: true });
  mkdirSync(join(fixture, "mainrepo", ".claude", "worktrees", "wt"), { recursive: true });
  writeFileSync(
    join(fixture, "mainrepo", ".claude", "worktrees", "wt", ".git"),
    `gitdir: ${join(fixture, "mainrepo", ".git", "worktrees", "wt")}\n`,
  );
  mkdirSync(join(fixture, "notgit", "sub"), { recursive: true });
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("preTrust (worktree trust seeding)", () => {
  const statePath = join(fixture, "claude-state.json");

  function callPreTrust(dir: string) {
    const launcher = new ConsoleLauncher(
      { all: () => [] } as never, // registry unused by preTrust
      undefined as never,
      "claude",
      { info: () => {}, warn: () => {} } as never,
      true,
      1000,
      statePath,
    );
    (launcher as unknown as { preTrust(d: string): void }).preTrust(dir);
  }

  it("adds hasTrustDialogAccepted for the new dir, preserving existing state", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ userId: "u1", projects: { "C:\\old": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } } }),
    );
    callPreTrust("C:\\dev\\repo\\.claude\\worktrees\\amber-wombat");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.userId).toBe("u1");
    expect(state.projects["C:\\old"].allowedTools).toEqual(["Bash"]);
    expect(state.projects["C:\\dev\\repo\\.claude\\worktrees\\amber-wombat"].hasTrustDialogAccepted).toBe(true);
  });

  it("tolerates a corrupt state file without throwing", () => {
    writeFileSync(statePath, "{broken");
    expect(() => callPreTrust("C:\\dev\\x")).not.toThrow();
  });
});

describe("pre-warmed spare worktree (real git)", () => {
  const repo = join(fixture, "prewarm-repo");
  const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  function makeLauncher() {
    return new ConsoleLauncher(
      { all: () => [] } as never,
      undefined as never,
      "claude",
      noopLog,
      true,
      30_000,
      join(fixture, "prewarm-claude-state.json"),
    );
  }

  beforeAll(() => {
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "first"]);
  });

  it("banks a spare, then claims it onto the CURRENT head under the new name", async () => {
    const launcher = makeLauncher();
    await launcher.prewarm(repo);
    const spare = join(repo, ".claude", "worktrees", "_spare");
    expect(existsSync(join(spare, ".git"))).toBe(true);
    const spareHead = git(spare, ["rev-parse", "HEAD"]);

    // The repo moves on while the spare sits idle — the whole hazard of
    // pre-warming. Claiming must NOT hand back a tree on the stale base.
    writeFileSync(join(repo, "b.txt"), "two\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "second"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    expect(head).not.toBe(spareHead);

    const dir = join(repo, ".claude", "worktrees", "brisk-otter");
    expect(await launcher.claimSpare(repo, "brisk-otter", dir)).toBe(dir);
    expect(existsSync(spare)).toBe(false); // moved, not copied
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head); // re-cut on current head
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("deck/brisk-otter");
    expect(existsSync(join(dir, "b.txt"))).toBe(true); // the newer commit's file
  });

  it("redirects a non-git cwd to the configured root, keeps a git cwd", () => {
    const launcher = makeLauncher();
    const nonGit = join(fixture, "notgit"); // exists, not a repo (created above)
    // Desktop-app home dir / any non-git folder → fall back to the root.
    expect(launcher.resolveLaunchDir(nonGit, repo)).toBe(repo);
    // A real repo target is kept — New branches off what you're pointed at.
    expect(launcher.resolveLaunchDir(repo, join(fixture, "prewarm-repo"))).toBe(repo);
    // A stale/absent cwd also redirects.
    expect(launcher.resolveLaunchDir(join(fixture, "gone"), repo)).toBe(repo);
    // No fallback configured → cwd stands, even if non-git (spawn-in-place).
    expect(launcher.resolveLaunchDir(nonGit, undefined)).toBe(nonGit);
    // Never redirect a git repo, even with a fallback.
    expect(launcher.resolveLaunchDir(repo, repo)).toBe(repo);
  });

  it("claiming with no spare banked returns null so the caller builds one", async () => {
    const launcher = makeLauncher();
    const dir = join(repo, ".claude", "worktrees", "keen-vole");
    expect(await launcher.claimSpare(repo, "keen-vole", dir)).toBeNull();
  });

  it("re-banks after a claim, and banking twice is a no-op", async () => {
    const launcher = makeLauncher();
    await launcher.prewarm(repo);
    const spare = join(repo, ".claude", "worktrees", "_spare");
    expect(existsSync(join(spare, ".git"))).toBe(true);
    await launcher.prewarm(repo); // must not throw or duplicate
    expect(existsSync(join(spare, ".git"))).toBe(true);
  });
});

describe("findRepoRoot", () => {
  it("finds the root from inside a normal repo (walking up)", () => {
    expect(findRepoRoot(join(fixture, "mainrepo", "src", "deep"))).toBe(join(fixture, "mainrepo"));
  });

  it("follows a worktree's gitdir pointer back to the MAIN root", () => {
    expect(findRepoRoot(join(fixture, "mainrepo", ".claude", "worktrees", "wt"))).toBe(
      join(fixture, "mainrepo"),
    );
  });

  it("returns null outside any repo", () => {
    expect(findRepoRoot(join(fixture, "notgit", "sub"))).toBeNull();
  });
});
