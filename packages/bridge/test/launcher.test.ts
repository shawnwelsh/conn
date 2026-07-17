import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findRepoRoot } from "../src/delivery/launcher.js";

const fixture = join(tmpdir(), `claude-deck-launcher-test-${process.pid}`);

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
