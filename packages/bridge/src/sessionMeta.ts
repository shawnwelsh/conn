import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log.js";

/**
 * Claude Code's own per-session metadata, which it keeps in
 * `~/.claude/sessions/<pid>.json` while a session is running:
 *
 *   {"pid":92100,"sessionId":"1b299bf2-…","cwd":"…\\worktrees\\brisk-wombat",
 *    "kind":"interactive","name":"Renewal Fix","status":"busy", …}
 *
 * `/rename` (alias `/name`) writes that `name`, which makes it a free naming
 * channel for the deck: name a session in the console and its key follows.
 * Auto-generated names carry `nameSource:"derived"` (they're just the cwd
 * leaf plus a hash — "dazzling-williams-cb6de4-18") and are ignored; the
 * branch-derived label is a better button than that.
 *
 * Read-only and best-effort: this is Claude Code's file, not ours, so a
 * schema change or a locked read degrades to "no external names" rather than
 * breaking the deck.
 *
 * (`/color` sets the prompt bar color for a session but persists NOWHERE we
 * can see — not here, not in ~/.claude.json — so the deck cannot mirror it.)
 */

export const CC_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** sessionId → the human name a user (or Claude) gave the conversation. */
export function readCcSessionNames(dir: string = CC_SESSIONS_DIR, log?: Logger): Map<string, string> {
  const names = new Map<string, string>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return names; // no such dir (fresh install / different CC layout)
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        sessionId?: unknown;
        name?: unknown;
        nameSource?: unknown;
      };
      if (typeof meta.sessionId !== "string" || typeof meta.name !== "string") continue;
      if (meta.nameSource === "derived") continue; // cwd-derived filler, not a name
      const name = meta.name.trim();
      if (name) names.set(meta.sessionId, name);
    } catch (err) {
      log?.debug({ file, err: String(err) }, "session meta: unreadable, skipped");
    }
  }
  return names;
}
