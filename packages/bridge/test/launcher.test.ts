import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findRepoRoot, ConsoleLauncher } from "../src/delivery/launcher.js";

const fixture = join(tmpdir(), `belay-launcher-test-${process.pid}`);

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
