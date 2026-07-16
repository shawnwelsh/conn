import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { DeliveryAdapter } from "./adapter.js";
import type { SessionRegistry } from "../registry.js";
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
 */
export class ConsoleLauncher {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly delivery: DeliveryAdapter,
    private readonly command: string, // e.g. "claude"
    private readonly log: Logger,
  ) {}

  /** Launch a new console session in `cwd`. Resolves once the pending launch
   * is registered (window handle may bind a moment later). */
  async launch(cwd: string): Promise<boolean> {
    if (!existsSync(cwd)) {
      this.log.warn({ cwd }, "launcher: cwd does not exist");
      return false;
    }
    // ShellExecute (Start-Process) is the only spawn path that reliably
    // creates a real console window — Node's detached spawn uses
    // DETACHED_PROCESS on Windows, which creates NO console at all.
    // -PassThru hands back the cmd.exe pid for HWND binding.
    const psq = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const script =
      `(Start-Process -FilePath cmd.exe -ArgumentList '/k',${psq(this.command)} ` +
      `-WorkingDirectory ${psq(cwd)} -PassThru).Id`;
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
      this.log.warn({ cwd }, "launcher: spawn failed (no pid)");
      return false;
    }

    // The console window can take a beat to exist; poll for the HWND.
    let hwnd: number | null = null;
    for (let i = 0; i < 15 && !hwnd; i++) {
      await new Promise((r) => setTimeout(r, 400));
      hwnd = await this.delivery.findWindowByPid(pid);
    }

    this.registry.registerPendingLaunch({ cwd, pid, hwnd, at: Date.now() });
    this.log.info({ cwd, pid, hwnd }, "launcher: console spawned, awaiting SessionStart");
    return true;
  }
}
