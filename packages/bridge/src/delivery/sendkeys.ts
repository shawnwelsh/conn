import { spawn } from "node:child_process";
import type { DeliveryAdapter, SessionRef } from "./adapter.js";
import type { Logger } from "../log.js";

/**
 * Degraded zero-dependency fallback (config.delivery.adapter = "sendkeys").
 * Spawns PowerShell per call (~300-800ms) and uses WScript.Shell
 * AppActivate + SendKeys — weaker window targeting and flakier modifiers
 * than the AHK daemon. Kept for machines without AutoHotkey.
 */

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** chord → SendKeys syntax ("+{TAB}", "^n", "{ENTER}"). */
export function chordToSendKeys(chord: string): string {
  const parts = chord.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => ({ shift: "+", ctrl: "^", alt: "%" })[m] ?? "").join("");
  const named: Record<string, string> = {
    enter: "{ENTER}", escape: "{ESC}", esc: "{ESC}", tab: "{TAB}",
    space: " ", up: "{UP}", down: "{DOWN}", backspace: "{BACKSPACE}",
  };
  return mods + (named[key] ?? key);
}

/** Escape literal text for SendKeys (its specials: +^%~(){}[]). */
export function escapeSendKeysText(text: string): string {
  return text.replace(/([+^%~(){}[\]])/g, "{$1}");
}

export class SendKeysAdapter implements DeliveryAdapter {
  constructor(
    private readonly log: Logger,
    private readonly windowMode: "activeWindow" | "perSession" = "activeWindow",
  ) {}

  private run(script: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5000);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  private activate(session: SessionRef): string {
    const sh = `$sh = New-Object -ComObject WScript.Shell; `;
    const settle = `Start-Sleep -Milliseconds 150; `;
    if (this.windowMode === "activeWindow") {
      // Intentionally the app's front window (visible conversation).
      return sh + `if (-not $sh.AppActivate('Claude')) { exit 1 }; ` + settle;
    }
    // Per-session: try the session title, fall back to the app.
    return (
      sh +
      `if (-not $sh.AppActivate(${psQuote(session.label)})) { if (-not $sh.AppActivate('Claude')) { exit 1 } }; ` +
      settle
    );
  }

  async focus(session: SessionRef): Promise<boolean> {
    const ok = await this.run(this.activate(session) + "exit 0");
    if (!ok) this.log.warn({ session: session.label }, "sendkeys: focus failed");
    return ok;
  }

  async sendText(session: SessionRef, text: string): Promise<boolean> {
    const keys = escapeSendKeysText(text.replace(/\r?\n/g, " "));
    return this.run(this.activate(session) + `$sh.SendKeys(${psQuote(keys)}); exit 0`);
  }

  async sendKey(session: SessionRef, chord: string): Promise<boolean> {
    return this.run(this.activate(session) + `$sh.SendKeys(${psQuote(chordToSendKeys(chord))}); exit 0`);
  }

  async sendSequence(session: SessionRef, chords: string[]): Promise<boolean> {
    const sends = chords
      .map((c) => `$sh.SendKeys(${psQuote(chordToSendKeys(c))}); Start-Sleep -Milliseconds 200;`)
      .join(" ");
    return this.run(this.activate(session) + sends + " exit 0");
  }

  async findWindowByPid(): Promise<number | null> {
    return null; // SendKeys fallback has no window enumeration
  }

  async dispose(): Promise<void> {}
}
