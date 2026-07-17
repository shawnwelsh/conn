import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, basename } from "node:path";
import type { DeliveryAdapter } from "./adapter.js";
import { samePath, type SessionRegistry } from "../registry.js";
import type { Logger } from "../log.js";

/**
 * Spawns a Claude Code session in its OWN console window and binds that
 * window to the session for exact HWND targeting.
 *
 * Why not window titles: CC overwrites the terminal title with its own
 * ("✳ Claude Code"), so titles can't disambiguate sessions. Instead we track
 * the PID we spawned, ask the AHK daemon for its window handle, and register
 * a pending launch — the next SessionStart arriving from that cwd (within
 * 90s) binds to the handle and is classified windowKind: "console".
 *
 * With worktrees enabled (default), each New press also creates a FRESH git
 * worktree on branch `deck/<codename>` — parallel sessions never share a
 * working tree, and because row-1 labels derive from the branch, the
 * codename IS the feature name shown on the button.
 */

const ADJECTIVES = [
  "amber", "bold", "brisk", "calm", "clever", "crisp", "deft", "eager",
  "fleet", "keen", "lucid", "merry", "nimble", "quick", "quiet", "spry",
  "steady", "swift", "tidy", "vivid",
];
const NOUNS = [
  "badger", "condor", "falcon", "gecko", "heron", "ibex", "jackal", "koala",
  "lynx", "marten", "otter", "panda", "quokka", "raven", "stoat", "tapir",
  "urchin", "vole", "wombat", "yak",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Resolve the MAIN repo root for a cwd — walking up to `.git`, and following
 * a worktree's `gitdir:` pointer (…/.git/worktrees/<name>) back to the
 * primary checkout so new worktrees are created as siblings, not nested.
 */
export function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    const dotgit = join(dir, ".git");
    try {
      const st = statSync(dotgit);
      if (st.isDirectory()) return dir;
      const m = readFileSync(dotgit, "utf8").trim().match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      const gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
      // <mainRoot>/.git/worktrees/<name> → <mainRoot>
      if (basename(dirname(gitDir)) === "worktrees") {
        const mainRoot = dirname(dirname(dirname(gitDir)));
        return existsSync(join(mainRoot, ".git")) ? mainRoot : null;
      }
      return null;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

export class ConsoleLauncher {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly delivery: DeliveryAdapter,
    private readonly command: string, // e.g. "claude"
    private readonly log: Logger,
    private readonly useWorktrees: boolean = true,
    private readonly worktreeTimeoutMs: number = 90_000,
  ) {}

  /** Two-word codename, collision-checked against existing worktree dirs.
   * This name becomes the branch (deck/<name>), the worktree dir, and —
   * via the branch-derived label — the feature name on the button. */
  private codename(root: string): string {
    for (let i = 0; i < 20; i++) {
      const name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
      if (!existsSync(join(root, ".claude", "worktrees", name))) return name;
    }
    return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Date.now() % 1000}`;
  }

  /** Create `<root>/.claude/worktrees/<name>` on branch `deck/<name>`.
   * Returns the worktree path, or null on any failure (caller falls back). */
  private async createWorktree(root: string): Promise<string | null> {
    const name = this.codename(root);
    const dir = join(root, ".claude", "worktrees", name);
    this.log.info({ root, name, timeoutMs: this.worktreeTimeoutMs }, "launcher: creating worktree…");
    const args = ["-C", root, "worktree", "add", dir, "-b", `deck/${name}`];
    const result = await new Promise<{ code: number | null; err: string }>((res) => {
      const git = spawn("git", args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      let err = "";
      git.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => {
        git.kill();
        res({ code: null, err: "timeout" });
      }, this.worktreeTimeoutMs);
      git.on("exit", (code) => {
        clearTimeout(timer);
        res({ code, err });
      });
    });
    if (result.code !== 0) {
      // OneDrive-backed repos can finish the checkout AFTER our timeout kill
      // (git's work completes; only its exit is late). If the worktree
      // materialized anyway, use it rather than stranding it.
      if (result.err === "timeout" && existsSync(join(dir, ".git"))) {
        this.log.warn({ dir }, "launcher: worktree materialized after timeout — using it");
        return dir;
      }
      this.log.warn({ root, name, err: result.err.trim() }, "launcher: worktree add failed");
      return null;
    }
    this.log.info({ dir, branch: `deck/${name}` }, "launcher: worktree created");
    return dir;
  }

  /** Launch a new console session for the targeted session's repo. With
   * worktrees enabled, the session gets its own fresh working tree on
   * branch deck/<codename>; otherwise (or on any git failure) it spawns
   * directly in `cwd`. Resolves once the pending launch is registered. */
  async launch(cwd: string): Promise<boolean> {
    if (!existsSync(cwd)) {
      this.log.warn({ cwd }, "launcher: cwd does not exist");
      return false;
    }

    let spawnDir = cwd;
    if (this.useWorktrees) {
      const root = findRepoRoot(cwd);
      if (root) {
        const worktree = await this.createWorktree(root);
        if (worktree) spawnDir = worktree;
      } else {
        this.log.warn({ cwd }, "launcher: not a git repo — spawning in place");
      }
    }

    // Two sessions editing one working tree WILL step on each other's files;
    // allow it (fallback path) but say so loudly.
    const sharing = this.registry.all().filter((s) => samePath(s.cwd, spawnDir));
    if (sharing.length > 0) {
      this.log.warn(
        { cwd: spawnDir, existing: sharing.map((s) => s.label) },
        "launcher: spawning into a cwd already used by another session — they will share the working tree",
      );
    }
    // ShellExecute (Start-Process) is the only spawn path that reliably
    // creates a real console window — Node's detached spawn uses
    // DETACHED_PROCESS on Windows, which creates NO console at all.
    // -PassThru hands back the cmd.exe pid for HWND binding.
    const psq = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const script =
      `(Start-Process -FilePath cmd.exe -ArgumentList '/k',${psq(this.command)} ` +
      `-WorkingDirectory ${psq(spawnDir)} -PassThru).Id`;
    const pid = await new Promise<number | null>((resolve) => {
      const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      ps.stdout.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        ps.kill();
        resolve(null);
      }, 8000);
      ps.on("exit", () => {
        clearTimeout(timer);
        const n = Number(out.trim());
        resolve(Number.isInteger(n) && n > 0 ? n : null);
      });
    });
    if (!pid) {
      this.log.warn({ cwd: spawnDir }, "launcher: spawn failed (no pid)");
      return false;
    }

    // The console window can take a beat to exist; poll for the HWND.
    let hwnd: number | null = null;
    for (let i = 0; i < 15 && !hwnd; i++) {
      await new Promise((r) => setTimeout(r, 400));
      hwnd = await this.delivery.findWindowByPid(pid);
    }

    this.registry.registerPendingLaunch({ cwd: spawnDir, pid, hwnd, at: Date.now() });
    this.log.info({ cwd: spawnDir, pid, hwnd }, "launcher: console spawned, awaiting SessionStart");
    return true;
  }
}
