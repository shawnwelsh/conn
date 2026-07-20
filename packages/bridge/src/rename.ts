import { spawn } from "node:child_process";
import type { Logger } from "./log.js";

/**
 * Naming a session from the deck.
 *
 * Deck-spawned sessions get a random codename (brisk-wombat) because the
 * feature usually doesn't have a name yet at New-press time — you discover it
 * as the work takes shape. Renaming later has to fix the REAL artifact, not
 * just the button: `deck/brisk-wombat` is what lands on the pull request. So
 * when the session sits on a deck-created branch we rename the branch and let
 * the existing label derivation carry the new name to the key; anything else
 * (a real feature branch, a non-git dir, the desktop app) gets a display-only
 * override instead — we never rewrite a branch the deck didn't create.
 */

/** Whisper gives prose ("Stream deck push to talk."); the branch needs a
 * slug. Returns null when nothing usable survives normalization. */
export function slugifyName(raw: string): { label: string; slug: string } | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ") // drop punctuation whisper adds
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  // Git refs reject some sequences outright; a plain kebab slug dodges all of
  // them. Cap the length so a rambling take can't produce a monster branch.
  const words = cleaned.split(" ").slice(0, 8);
  const label = words.join(" ");
  const slug = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug ? { label, slug } : null;
}

/** Only branches WE created are safe to rewrite. */
export function isDeckBranch(branch: string | null): boolean {
  return Boolean(branch?.startsWith("deck/"));
}

/**
 * `git branch -m` inside the session's worktree. Renaming the checked-out
 * branch of a worktree is safe and local; the label sweep picks the new name
 * up from .git HEAD on its next pass.
 */
export function renameDeckBranch(
  cwd: string,
  from: string,
  to: string,
  log: Logger,
  timeoutMs = 15_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const git = spawn("git", ["-C", cwd, "branch", "-m", from, to], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, // OneDrive index locks
    });
    let err = "";
    git.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      git.kill();
      log.warn({ cwd, from, to }, "rename: git branch -m timed out");
      resolve(false);
    }, timeoutMs);
    git.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        log.info({ cwd, from, to }, "rename: branch renamed");
        resolve(true);
      } else {
        log.warn({ cwd, from, to, err: err.trim() }, "rename: git branch -m failed");
        resolve(false);
      }
    });
    git.on("error", (e) => {
      clearTimeout(timer);
      log.warn({ err: String(e) }, "rename: git spawn failed");
      resolve(false);
    });
  });
}
