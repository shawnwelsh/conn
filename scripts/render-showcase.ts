/**
 * Renders the README/showcase hero image through the REAL deck pipeline —
 * computeTiles → renderTile / renderBanner — so what the page shows is exactly
 * what the device draws (sliced banner, ›_ prompt mark, the waiting "!" shape,
 * the vector row-3 icons), not a hand-drawn approximation.
 *
 * Scene: a Bash permission on the "invoicing" console — key 0 is the asker,
 * keys 1-4 are the command banner, row 2 is the answer morph, row 3 the globals.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs scripts/render-showcase.ts
 * Output: docs/showcase-deck.png
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { SessionRegistry } from "../packages/bridge/src/registry.js";
import {
  computeTiles,
  initialRow1,
  initialRow2Cmd,
  initialControls,
  type DeckLayerState,
} from "../packages/bridge/src/layers.js";
import { renderTile, renderBanner } from "../packages/bridge/src/render/tile.js";
import type { DeckConfig } from "../packages/bridge/src/config.js";

const cfg = {
  port: 3711, decisionTimeoutSeconds: 30, slots: 5, maxSessions: 15,
  doubleTapMs: 300, longPressMs: 500, moveCancelSeconds: 5, cmdPagerRevertSeconds: 6,
  staleSessionMinutes: 60, deadSessionSweepHours: 3, alwaysAllowDestination: "session",
  delivery: { adapter: "noop", ahkPath: "", windowMode: "activeWindow" },
  commandsFile: "commands.json", newSessionCommand: "claude", consoleHost: "wt",
  newSessionWorktrees: true, worktreeTimeoutSeconds: 90, suggestionAcceptText: "yes",
  desktopSubmitDelayMs: 250,
  ptt: { enabled: true, python: "python", model: "distil-small.en", language: "en", maxSeconds: 60, reasonMaxSeconds: 10, renameMaxSeconds: 10 },
  optionReader: { enabled: false, model: "haiku", timeoutSeconds: 20 },
  log: { level: "info", dir: "logs" },
} as unknown as DeckConfig;

// Stage the scene: one console session, mid-permission.
const registry = new SessionRegistry(5, 15);
registry.ensure({ session_id: "invoicing", cwd: "C:/dev/revops/invoicing", hook_event_name: "SessionStart" });
const asker = registry.get("invoicing")!;
asker.windowKind = "console"; // → the ›_ prompt mark
asker.status = "waiting"; // → the "!" attention shape
registry.target("invoicing");

const layer: DeckLayerState = {
  row1: initialRow1(),
  row2: "permission",
  row2Cmd: initialRow2Cmd(),
  row3Page: 0,
  controls: initialControls(),
  ptt: "ready",
  permission: {
    sessionId: "invoicing",
    toolName: "Bash",
    summary: "git push --force origin main",
    depth: 1,
    expiresAt: Date.now() + 25_000,
  },
};

const tiles = computeTiles(registry, layer, cfg, [], false);
if (tiles.length !== 15) throw new Error(`expected 15 tiles, got ${tiles.length}`);

// Render each tile through the real pipeline (banner slices included).
const pngs = tiles.map((t) =>
  t.bannerSpan && t.bannerIndex !== undefined
    ? renderBanner(t.text, t.bannerSpan, t.state)[t.bannerIndex]!
    : renderTile(t),
);

// Compose onto a dark device panel with gaps between keys.
const S = 144, GAP = 16, PAD = 22, COLS = 5, ROWS = 3, RADIUS = 28;
const W = COLS * S + (COLS - 1) * GAP + PAD * 2;
const H = ROWS * S + (ROWS - 1) * GAP + PAD * 2;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#0a0a0a";
ctx.beginPath();
ctx.roundRect(0, 0, W, H, RADIUS);
ctx.fill();

for (let i = 0; i < pngs.length; i++) {
  const img = await loadImage(pngs[i]!);
  const col = i % COLS, row = Math.floor(i / COLS);
  ctx.drawImage(img, PAD + col * (S + GAP), PAD + row * (S + GAP), S, S);
}

const buf = canvas.toBuffer("image/png");
const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const out = join(docsDir, "showcase-deck.png");
writeFileSync(out, buf);

// Embed the render into showcase.html as a data URI, so the hero is never a
// broken <img> however the page is opened (file://, the preview pane, GitHub
// Pages). The README keeps the plain file reference, which GitHub serves fine.
const htmlPath = join(docsDir, "showcase.html");
const dataUri = "data:image/png;base64," + buf.toString("base64");
const html = readFileSync(htmlPath, "utf8").replace(
  /src="(?:showcase-deck\.png|data:image\/png;base64,[^"]*)"/,
  `src="${dataUri}"`,
);
writeFileSync(htmlPath, html);
console.log(`wrote ${out} (${W}×${H}) and embedded it in showcase.html`);
