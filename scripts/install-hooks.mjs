/**
 * Merges the belay hook block into ~/.claude/settings.json.
 *
 * - Purely additive: existing hooks, permissions, and other settings are
 *   never modified or removed. Our entries are appended per-event.
 * - Idempotent: entries whose URL already exists for an event are skipped.
 * - Shows the full before/after diff and asks for confirmation before
 *   writing. A timestamped backup is written next to the original.
 *
 * Usage:
 *   node scripts/install-hooks.mjs           # interactive diff + confirm
 *   node scripts/install-hooks.mjs --dry-run # print diff only, never write
 *   node scripts/install-hooks.mjs --yes     # apply without prompting
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

const PORT = process.env.CLAUDE_DECK_PORT ?? "3711";
const BASE = `http://127.0.0.1:${PORT}`;

const HOOK_BLOCK = {
  SessionStart: [{ hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] }],
  SessionEnd: [{ hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] }],
  PostToolUse: [{ matcher: "*", hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] }],
  PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] }],
  Notification: [
    { matcher: "permission_prompt|idle_prompt", hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] },
  ],
  Stop: [{ hooks: [{ type: "http", url: `${BASE}/hooks/event`, timeout: 3 }] }],
  PreToolUse: [
    { matcher: "AskUserQuestion", hooks: [{ type: "http", url: `${BASE}/hooks/question`, timeout: 3 }] },
  ],
  PermissionRequest: [
    { matcher: "*", hooks: [{ type: "http", url: `${BASE}/hooks/permission-request`, timeout: 35 }] },
  ],
};

const settingsPath = process.env.CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
const dryRun = process.argv.includes("--dry-run");
const autoYes = process.argv.includes("--yes");

const original = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}";
const settings = JSON.parse(original);
settings.hooks ??= {};

let added = 0;
for (const [event, entries] of Object.entries(HOOK_BLOCK)) {
  settings.hooks[event] ??= [];
  const existingUrls = new Set(
    settings.hooks[event].flatMap((e) => (e.hooks ?? []).map((h) => h.url).filter(Boolean)),
  );
  for (const entry of entries) {
    const url = entry.hooks[0].url;
    if (existingUrls.has(url)) continue;
    settings.hooks[event].push(entry);
    added++;
  }
}

const updated = JSON.stringify(settings, null, 2) + "\n";
if (added === 0) {
  console.log("All belay hooks already present — nothing to do.");
  process.exit(0);
}

console.log(`Target file: ${settingsPath}`);
console.log(`New hook entries to add: ${added}\n`);
console.log("----- current -----");
console.log(original);
console.log("----- proposed -----");
console.log(updated);

if (dryRun) {
  console.log("(dry-run: no changes written)");
  process.exit(0);
}

if (!autoYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Apply these changes? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted — nothing written.");
    process.exit(1);
  }
}

const backup = `${settingsPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (existsSync(settingsPath)) copyFileSync(settingsPath, backup);
writeFileSync(settingsPath, updated);
console.log(`Backup written to ${backup}`);
console.log(`Updated ${settingsPath}`);
