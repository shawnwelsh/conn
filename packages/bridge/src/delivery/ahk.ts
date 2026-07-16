import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
const COMMAND_TIMEOUT_MS = 4000;

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
    return this.withWindow(session, async (query) => this.command(`focus|${query}`));
  }

  async sendText(session: SessionRef, text: string): Promise<boolean> {
    const safe = text.replace(/\r?\n/g, " ");
    return this.withWindow(session, async (query) => this.command(`text|${query}|${safe}`));
  }

  async sendKey(session: SessionRef, chord: string): Promise<boolean> {
    return this.withWindow(session, async (query) => this.command(`key|${query}|${chordToAhk(chord)}`));
  }

  async sendSequence(session: SessionRef, chords: string[]): Promise<boolean> {
    const ahk = chords.map(chordToAhk).join("|");
    return this.withWindow(session, async (query) => this.command(`seq|${query}|${ahk}`));
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
