import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import type { DeliveryAdapter, SessionRef } from "./adapter.js";
import type { Logger } from "../log.js";

/**
 * AutoHotkey v2 daemon adapter — one persistent AHK process, pipe-delimited
 * commands over stdin, one "ok"/"err|…" line back per command. No
 * per-keystroke process spawns.
 *
 * Window resolution strategy (v1, desktop app): try the session label
 * (repo/cwd leaf, substring title match), then fall back to the Claude
 * desktop app itself. If only the fallback matches, we're in the documented
 * degraded mode: "focus the app, act on the visible session".
 */

const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), "daemon.ahk");
const FALLBACK_QUERY = "ahk_exe Claude.exe";
// ControlSend is fast; focus() activation (double-tap) can take a couple of
// seconds through the foreground-lock workarounds — allow generous headroom.
const COMMAND_TIMEOUT_MS = 8000;

/** chord ("shift+tab", "ctrl+n", "enter", "2") → AHK v2 Send syntax. */
export function chordToAhk(chord: string): string {
  const parts = chord.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mods = parts
    .map((m) => ({ shift: "+", ctrl: "^", alt: "!", win: "#" })[m] ?? "")
    .join("");
  const named: Record<string, string> = {
    enter: "{Enter}",
    escape: "{Esc}",
    esc: "{Esc}",
    tab: "{Tab}",
    space: "{Space}",
    up: "{Up}",
    down: "{Down}",
    backspace: "{Backspace}",
  };
  return mods + (named[key] ?? key);
}

/**
 * chord → the VT byte sequence a raw-mode TUI reads for that key. Console
 * sessions consume a byte stream (the tmux model), so special keys are just
 * their escape sequences — proven end-to-end via WriteConsoleInput against
 * both WT- and conhost-hosted raw-mode readers. Returns null for chords with
 * no VT form (e.g. ctrl+shift+m) — those fall back to the window path.
 */
export function chordToVt(chord: string): string | null {
  const named: Record<string, string> = {
    enter: "\r",
    escape: "\x1b",
    esc: "\x1b",
    tab: "\t",
    "shift+tab": "\x1b[Z",
    space: " ",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    backspace: "\x7f",
  };
  const key = chord.toLowerCase();
  if (named[key] !== undefined) return named[key];
  if (key.length === 1) return key; // plain character (digits for pickers)
  if (key.startsWith("ctrl+") && key.length === 6) {
    const c = key.charCodeAt(5) - 96; // ctrl+a → 0x01 … ctrl+z → 0x1a
    if (c >= 1 && c <= 26) return String.fromCharCode(c);
  }
  return null;
}

/** Encode conwrite payload: control bytes, '%' and '|' become %XX so the
 * newline/pipe-delimited daemon protocol stays unambiguous. */
export function pctEncode(text: string): string {
  return text.replace(/[\x00-\x1f%|\x7f]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

export class AhkAdapter implements DeliveryAdapter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ahkPath: string,
    private readonly log: Logger,
    private readonly windowMode: "activeWindow" | "perSession" = "activeWindow",
  ) {}

  async start(): Promise<void> {
    if (!existsSync(this.ahkPath)) {
      throw new Error(`AutoHotkey not found at ${this.ahkPath} (config.delivery.ahkPath)`);
    }
    this.proc = spawn(this.ahkPath, ["/ErrorStdOut", DAEMON_PATH], { stdio: "pipe" });
    this.lines = createInterface({ input: this.proc.stdout });
    this.proc.on("exit", (code) => {
      this.log.warn({ code }, "AHK daemon exited");
      this.proc = null;
    });
    const pong = await this.command("ping|");
    if (pong !== "ok") throw new Error(`AHK daemon ping failed: ${pong}`);
    this.log.info({ ahk: this.ahkPath }, "AHK delivery daemon up");
  }

  async focus(session: SessionRef): Promise<boolean> {
    if (session.pid && !session.hwnd) {
      // Console with a pid but no window handle — either a terminal we adopted
      // by pid (never learned its window) or, more often, one whose WT tab was
      // dragged to another window, closing the one we bound at launch. Delivery
      // still rides the pid; focus needs a window, so re-find it. Never the app
      // fallback: that surfaces the Claude desktop app, a different program.
      const hwnd = await this.recoverConsoleWindow(session);
      if (!hwnd) {
        this.log.info({ session: session.label, pid: session.pid }, "focus unavailable: no window handle and none re-found");
        return false;
      }
      return (await this.command(`focus|ahk_id ${hwnd}`)) === "ok";
    }
    return this.withWindow(session, async (query) => this.command(`focus|${query}`));
  }

  async setWindowState(session: SessionRef, state: "maximize" | "restore"): Promise<boolean> {
    const arg = state === "maximize" ? "max" : "restore";
    if (session.pid && !session.hwnd) {
      // Same re-find as focus: a moved tab lost its launch handle, but the
      // window is still there under the title the tab carries.
      const hwnd = await this.recoverConsoleWindow(session);
      if (!hwnd) return false;
      return (await this.command(`winstate|ahk_id ${hwnd}|${arg}`)) === "ok";
    }
    return this.withWindow(session, async (query) => this.command(`winstate|${query}|${arg}`));
  }

  /**
   * Re-find a console window whose launch handle is gone. The usual cause is a
   * Windows Terminal tab dragged to another window: the old window closes, its
   * handle dies, and the liveness sweep drops it — leaving the session pid-only
   * (commands still deliver into its input buffer; focus and maximize have no
   * window to act on). A WT window can't be found from the console's pid (it
   * belongs to WindowsTerminal.exe), so:
   *   1. try the pid anyway — that resolves a classic conhost window exactly;
   *   2. else match the title the tab still carries — the Claude Code name
   *      (ccName, set as the terminal title on /rename) or, before any rename,
   *      the launch codename (the cwd leaf) — constrained to WindowsTerminal.exe
   *      so a same-named editor or explorer window can't be mistaken for it.
   * Best-effort: title recovery only works while the moved tab is its window's
   * ACTIVE tab (so the window title reflects it). Returns null otherwise, and
   * the caller refuses rather than raising the wrong window.
   */
  private async recoverConsoleWindow(session: SessionRef): Promise<number | null> {
    if (!session.pid) return null;
    const byPid = await this.findWindowByPid(session.pid);
    if (byPid) {
      this.log.info({ session: session.label, pid: session.pid, hwnd: byPid }, "re-found console window by pid");
      return byPid;
    }
    const leaf = session.cwd ? basename(session.cwd) : "";
    const titles = [...new Set([session.ccName, leaf].filter(Boolean))] as string[];
    for (const title of titles) {
      const hwnd = await this.findWindowByTitle(`${title} ahk_exe WindowsTerminal.exe`);
      if (hwnd) {
        this.log.info({ session: session.label, title, hwnd }, "re-found moved WT window by title");
        return hwnd;
      }
    }
    return null;
  }

  async sendText(session: SessionRef, text: string): Promise<boolean> {
    const safe = text.replace(/\r?\n/g, " ");
    if (session.pid) return this.conWrite(session, safe);
    return this.withWindow(session, async (query) => this.command(`text|${query}|${safe}`));
  }

  async sendKey(session: SessionRef, chord: string): Promise<boolean> {
    if (session.pid) {
      const vt = chordToVt(chord);
      if (vt !== null) return this.conWrite(session, vt);
      // No VT form (desktop-app chords) — fall through to the window path.
    }
    return this.withWindow(session, async (query) => this.command(`key|${query}|${chordToAhk(chord)}`));
  }

  async sendSequence(session: SessionRef, chords: string[]): Promise<boolean> {
    if (session.pid) {
      const vts = chords.map(chordToVt);
      if (vts.every((v) => v !== null)) return this.conWrite(session, vts.join(""));
    }
    const ahk = chords.map(chordToAhk).join("|");
    return this.withWindow(session, async (query) => this.command(`seq|${query}|${ahk}`));
  }

  /**
   * Console input-buffer injection (AttachConsole+WriteConsoleInput daemon
   * side): focus-free, window-free, identical for Windows Terminal and
   * classic conhost. Exact-target semantics — a dead process is a refusal,
   * never an app-window fallback.
   */
  private async conWrite(session: SessionRef, bytes: string): Promise<boolean> {
    const reply = await this.command(`conwrite|${session.pid}|${pctEncode(bytes)}`);
    if (reply === "ok") return true;
    const why =
      reply === "err|gone"
        ? "delivery refused: console process gone (session likely closed) — not falling back"
        : `delivery failed: ${reply}`;
    this.log.warn({ session: session.label, pid: session.pid, reply }, why);
    return false;
  }

  async findWindowByPid(pid: number): Promise<number | null> {
    const reply = await this.command(`findpid|${pid}`);
    const m = reply.match(/^hwnd\|(\d+)$/);
    const hwnd = m ? Number(m[1]) : 0;
    return hwnd > 0 ? hwnd : null;
  }

  async findWindowByTitle(title: string): Promise<number | null> {
    const reply = await this.command(`findtitle|${title}`);
    const m = reply.match(/^hwnd\|(\d+)$/);
    const hwnd = m ? Number(m[1]) : 0;
    return hwnd > 0 ? hwnd : null;
  }

  async checkWindow(hwnd: number): Promise<boolean | null> {
    const reply = await this.command(`checkwin|${hwnd}`);
    const m = reply.match(/^alive\|([01])$/);
    return m ? m[1] === "1" : null; // daemon hiccup → unknown, not dead
  }

  async checkPid(pid: number): Promise<boolean | null> {
    const reply = await this.command(`checkpid|${pid}`);
    const m = reply.match(/^alive\|([01])$/);
    return m ? m[1] === "1" : null;
  }

  async dispose(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
  }

  /**
   * Resolve the target window. In "activeWindow" mode we intentionally act on
   * the Claude app's front window (the visible conversation) — this is the
   * correct, expected path for the tabbed desktop app, not a degradation. In
   * "perSession" mode we try the session's own window first, warning if we
   * can only reach the app.
   */
  private async withWindow(
    session: SessionRef,
    run: (query: string) => Promise<string>,
  ): Promise<boolean> {
    // A bound HWND (deck-launched console) is exact — use it regardless of
    // windowMode. Console commands go via ControlSend (focus-free) daemon
    // side. If the window is GONE, refuse: an exact-target session must never
    // degrade to typing into whatever conversation happens to be visible.
    if (session.hwnd) {
      const reply = await run(`ahk_id ${session.hwnd}`);
      if (reply === "ok") return true;
      const why =
        reply === "err|gone"
          ? "delivery refused: bound window gone (session likely closed) — not falling back"
          : reply === "err|noactivate"
            ? "delivery failed: window alive but focus refused (foreground lock)"
            : reply === "err|timeout"
              ? "delivery failed: AHK daemon did not respond in time"
              : `delivery failed: ${reply}`;
      this.log.warn({ session: session.label, hwnd: session.hwnd, reply }, why);
      return false;
    }
    if (this.windowMode === "activeWindow") {
      return (await run(FALLBACK_QUERY)) === "ok";
    }
    for (const query of [session.label, FALLBACK_QUERY]) {
      const result = await run(query);
      if (result === "ok") {
        if (query === FALLBACK_QUERY) {
          this.log.warn({ session: session.label }, "delivery degraded: focused app, not the specific session window");
        }
        return true;
      }
    }
    this.log.warn({ session: session.label }, "delivery failed: no matching window");
    return false;
  }

  /** Serialized request/response — the daemon answers strictly in order. */
  private command(line: string): Promise<string> {
    const exec = async (): Promise<string> => {
      if (!this.proc || !this.lines) {
        await this.start().catch((err) => {
          this.log.warn({ err: String(err) }, "AHK daemon restart failed");
        });
        if (!this.proc || !this.lines) return "err|daemon down";
      }
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.lines?.off("line", onLine);
          resolve("err|timeout");
        }, COMMAND_TIMEOUT_MS);
        const onLine = (reply: string) => {
          clearTimeout(timer);
          resolve(reply.trim());
        };
        this.lines!.once("line", onLine);
        this.proc!.stdin.write(line + "\n");
      });
    };
    const next = this.queue.then(exec, exec);
    this.queue = next.catch(() => {});
    return next;
  }
}
