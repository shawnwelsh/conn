import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import type { DeliveryAdapter } from "./adapter.js";
import { samePath, type SessionRegistry } from "../registry.js";
import type { BindingStore } from "../bindings.js";
import type { Logger } from "../log.js";

/**
 * Spawns a Claude Code session in its OWN console window and binds that
 * window to the session for exact HWND targeting.
 *
 * Binding model: we track the cmd PID we spawned (delivery injects into its
 * console input buffer — no window needed) plus the window handle (focus/
 * surfacing only), and register a pending launch — the next session hook
 * arriving from that cwd binds and is classified windowKind: "console".
 *
 * Console host (config consoleHost):
 *  - "wt" (default): Windows Terminal windows — full copy/paste, proper
 *    rendering. All WT windows belong to one WindowsTerminal.exe process, so
 *    the window is grabbed at spawn by its --title (the codename), while the
 *    cmd pid is resolved from a token embedded in its command line.
 *    Deliberately NOT --suppressApplicationTitle: Claude Code retitles the
 *    terminal when the conversation is renamed (its
 *    `terminalTitleFromRename` setting, on by default), so leaving it free
 *    means the WT tab tracks the session name — the same name the deck key
 *    and the branch carry. The cost is a race (once CC boots, our launch
 *    title is gone), so the window hunt runs CONCURRENTLY with pid
 *    resolution rather than after it. ControlSend can't reach WT windows —
 *    irrelevant, delivery is input-buffer injection by PID.
 *  - "conhost": classic console windows (owned by the cmd child; resolved
 *    via findpid). No WT dependency; poorer fonts, Mark-mode-only copy.
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
    /** CC's per-project state file; injectable for tests. */
    private readonly claudeStatePath: string = join(homedir(), ".claude.json"),
    /** Persists {cwd, pid, hwnd} so console bindings survive bridge restarts. */
    private readonly bindings?: BindingStore,
    /** Terminal hosting new consoles: "wt" (Windows Terminal) or "conhost". */
    private readonly consoleHost: "wt" | "conhost" = "wt",
  ) {}

  /**
   * Pre-trust a worktree WE just created, so Claude doesn't stall at the
   * folder-trust prompt in a console nobody has surfaced yet. Scope is
   * deliberately narrow: only called for deck-created worktrees of a repo
   * the user already works in — pressing New IS the trust decision.
   * (Best-effort: CC also writes this file; last-writer-wins is acceptable
   * for a single-user machine, and failure just means the prompt shows.)
   */
  private preTrust(dir: string): void {
    try {
      const state = existsSync(this.claudeStatePath)
        ? JSON.parse(readFileSync(this.claudeStatePath, "utf8"))
        : {};
      state.projects ??= {};
      const existing = state.projects[dir] ?? {};
      if (existing.hasTrustDialogAccepted === true) return;
      state.projects[dir] = { ...existing, hasTrustDialogAccepted: true };
      writeFileSync(this.claudeStatePath, JSON.stringify(state, null, 2));
      this.log.info({ dir }, "launcher: pre-trusted new worktree");
    } catch (err) {
      this.log.warn({ err: String(err), dir }, "launcher: pre-trust failed — the trust prompt will show");
    }
  }

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
  private async createWorktree(root: string, name: string, dir: string): Promise<string | null> {
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

    // Claim the deck key IMMEDIATELY — the codename and target dir are
    // computable in microseconds; everything slow (OneDrive git, spawn,
    // window polling) happens after the user already sees the key.
    let spawnDir = cwd;
    const root = this.useWorktrees ? findRepoRoot(cwd) : null;
    if (this.useWorktrees && !root) this.log.warn({ cwd }, "launcher: not a git repo — spawning in place");
    if (root) {
      const name = this.codename(root);
      const dir = join(root, ".claude", "worktrees", name);
      this.registry.addProvisionalAt(dir);
      const worktree = await this.createWorktree(root, name, dir);
      if (worktree) {
        spawnDir = worktree;
        this.preTrust(worktree);
        this.registry.refreshLabels(); // branch now exists → spaced feature name
      } else {
        this.registry.repointProvisional(dir, cwd); // shared-dir fallback keeps the key
      }
    } else {
      this.registry.addProvisionalAt(cwd);
    }

    // Two sessions editing one working tree WILL step on each other's files;
    // allow it (fallback path) but say so loudly. (Excluding provisional
    // entries — the key we just claimed for THIS launch isn't a conflict.)
    const sharing = this.registry
      .all()
      .filter((s) => !s.sessionId.startsWith("launching:") && samePath(s.cwd, spawnDir));
    if (sharing.length > 0) {
      this.log.warn(
        { cwd: spawnDir, existing: sharing.map((s) => s.label) },
        "launcher: spawning into a cwd already used by another session — they will share the working tree",
      );
    }
    // ShellExecute (Start-Process) is the spawn mechanism either way: Node's
    // detached spawn creates NO console window on Windows at all. Both paths
    // resolve and return the cmd CHILD pid — the process whose console
    // input buffer delivery injects into.
    const psq = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const token = `deck-${basename(spawnDir)}-${Date.now() % 100_000}`;
    // The tab opens under the codename (meaningful on sight, and unique —
    // codenames are collision-checked against existing worktrees) and is left
    // free for Claude Code to retitle on /rename.
    const title = basename(spawnDir);
    const script =
      this.consoleHost === "wt"
        ? // Windows Terminal: fresh window titled with the codename; the
          // token inside the cmd line makes the child pid findable by CIM.
          `$null = Start-Process wt.exe -ArgumentList '-w','new','--title',${psq(title)},` +
          `'-d',${psq(spawnDir)},'cmd','/k',` +
          `${psq(`set DECK_LAUNCH=${token}& ${this.command}`)}; ` +
          `$child = $null; ` +
          `for ($i = 0; $i -lt 24 -and -not $child; $i++) { ` +
          `Start-Sleep -Milliseconds 250; ` +
          `$child = (Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | ` +
          `Where-Object { $_.CommandLine -like "*${token}*" } | Select-Object -First 1).ProcessId }; ` +
          `if ($child) { $child } else { 0 }`
        : `$p = Start-Process -FilePath conhost.exe -ArgumentList 'cmd','/k',${psq(this.command)} ` +
          `-WorkingDirectory ${psq(spawnDir)} -PassThru; ` +
          `$child = $null; ` +
          `for ($i = 0; $i -lt 24 -and -not $child; $i++) { ` +
          `Start-Sleep -Milliseconds 250; ` +
          `$child = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id) and Name='cmd.exe'" | Select-Object -First 1).ProcessId }; ` +
          `if ($child) { $child } else { 0 }`;
    const pidPromise = new Promise<number | null>((resolve) => {
      const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      ps.stdout.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        ps.kill();
        resolve(null);
      }, 15_000); // spawn + CIM child-pid poll (~6s worst case) need headroom
      ps.on("exit", () => {
        clearTimeout(timer);
        const n = Number(out.trim());
        resolve(Number.isInteger(n) && n > 0 ? n : null);
      });
    });

    // Start hunting the WT window NOW, not after the pid resolves: the launch
    // title only survives until Claude Code boots and renames the terminal.
    const titleHunt =
      this.consoleHost === "wt"
        ? (async () => {
            for (let i = 0; i < 25; i++) {
              const found = await this.delivery.findWindowByTitle?.(title);
              if (found) return found;
              await new Promise((r) => setTimeout(r, 200));
            }
            return null;
          })()
        : Promise.resolve(null);

    const pid = await pidPromise;
    if (!pid) {
      this.log.warn({ cwd: spawnDir, host: this.consoleHost }, "launcher: spawn failed (no pid)");
      void titleHunt; // let it fall out on its own
      this.registry.dropProvisional(spawnDir); // take the key back
      return false;
    }

    // WT: whatever the concurrent title hunt caught (the window isn't the
    // cmd's, so it can only be found by title). conhost: the window belongs
    // to the cmd child, so the pid resolves it and can't go stale.
    let hwnd: number | null = null;
    if (this.consoleHost === "wt") {
      hwnd = await titleHunt;
      if (!hwnd) {
        this.log.warn({ cwd: spawnDir }, "launcher: window not caught before Claude Code retitled it — no focus target");
      }
    } else {
      for (let i = 0; i < 15 && !hwnd; i++) {
        await new Promise((r) => setTimeout(r, 400));
        hwnd = await this.delivery.findWindowByPid(pid);
      }
    }

    // Surface the new console — windows spawned by a background process open
    // WITHOUT foreground activation, so without this the console (and any
    // prompt inside it) sits invisibly behind everything.
    if (hwnd) {
      const surfaced = await this.delivery.focus({
        sessionId: "pending-launch",
        cwd: spawnDir,
        label: basename(spawnDir),
        hwnd,
      });
      if (!surfaced) this.log.warn({ hwnd }, "launcher: could not surface the new console");
    }

    this.registry.registerPendingLaunch({ cwd: spawnDir, pid, hwnd, at: Date.now() });
    this.registry.bindProvisional(spawnDir, { pid, hwnd });
    this.bindings?.upsert({ cwd: spawnDir, pid, hwnd: hwnd ?? undefined, at: Date.now() });
    this.log.info({ cwd: spawnDir, pid, hwnd, host: this.consoleHost }, "launcher: console spawned and bound to its key");
    return true;
  }
}
