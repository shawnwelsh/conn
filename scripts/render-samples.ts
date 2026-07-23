/**
 * Renders sample tiles to PNG files for visual inspection — the acceptance
 * check for auto-fit against real permission/question strings (not lorem
 * ipsum). Usage: node node_modules/tsx/dist/cli.mjs scripts/render-samples.ts <outDir>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderTile, renderBanner } from "../packages/bridge/src/render/tile.js";
import type { TileSpec } from "@conn/shared";

const outDir = process.argv[2] ?? "sample-tiles";
mkdirSync(outDir, { recursive: true });

const samples: Array<[string, TileSpec]> = [
  ["status-thinking", { text: "revops-platform", subtext: "thinking", state: "thinking", selected: true }],
  ["status-waiting", { text: "conn", subtext: "waiting", state: "waiting" }],
  ["status-error", { text: "email-agent", subtext: "error", state: "error" }],
  ["status-done", { text: "revops-platform", subtext: "done", state: "done" }],
  ["answer-allow", { text: "Allow", state: "answer" }],
  ["answer-always", { text: "Always allow", state: "answer" }],
  ["answer-long-option", { text: "Yes, and don't ask again", state: "answer", badge: "2" }],
  ["answer-longer-option", { text: "AutoHotkey v2 daemon (Recommended)", state: "answer", badge: "1" }],
  ["command-compact", { text: "/compact", state: "command" }],
  ["status-stale", { text: "email-agent", subtext: "done", state: "done", dim: true }],
];

for (const [name, spec] of samples) {
  writeFileSync(join(outDir, `${name}.png`), renderTile(spec));
}

const banner = renderBanner(
  "Bash: git push --force-with-lease origin feature/sfdc-quote-fix-2026-07-16",
  3,
  "waiting",
);
banner.forEach((buf, i) => writeFileSync(join(outDir, `banner-${i}.png`), buf));

console.log(`wrote ${samples.length + banner.length} PNGs to ${outDir}`);
