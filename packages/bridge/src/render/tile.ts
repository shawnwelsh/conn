import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import type { TileSpec } from "@claude-deck/shared";
import { themeFor, SELECTED_BORDER, TILE_SIZE, FONT_FAMILY } from "./theme.js";

/**
 * The single tile renderer every layer goes through.
 * renderTile(spec) → PNG buffer (144×144), LRU-cached by content hash so
 * status flicker never re-renders identical images.
 */

const CACHE_MAX = 500;
const cache = new Map<string, Buffer>(); // Map preserves insertion order → LRU

function cacheKey(input: unknown): string {
  return createHash("sha1").update(JSON.stringify(input)).digest("hex");
}

function cacheGet(key: string): Buffer | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // refresh recency
  }
  return hit;
}

function cachePut(key: string, buf: Buffer): void {
  cache.set(key, buf);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

interface Line {
  text: string;
  width: number;
}

/** Greedy word wrap at a given font size; returns null if it can't fit. */
function tryLayout(
  ctx: SKRSContext2D,
  text: string,
  fontPx: number,
  maxWidth: number,
  maxLines: number,
): Line[] | null {
  ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: Line[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (!current) return null; // single word wider than the tile at this size
    lines.push({ text: current, width: ctx.measureText(current).width });
    if (lines.length === maxLines) return null;
    current = word;
    if (ctx.measureText(current).width > maxWidth) return null;
  }
  if (current) {
    if (lines.length === maxLines) return null;
    lines.push({ text: current, width: ctx.measureText(current).width });
  }
  return lines.length ? lines : null;
}

/** Binary-search the largest font size whose wrap fits maxLines; falls back
 * to minimum size + ellipsis. */
function fitText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  minPx = 14,
  maxPx = 40,
): { fontPx: number; lines: Line[] } {
  let lo = minPx;
  let hi = maxPx;
  let best: { fontPx: number; lines: Line[] } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = tryLayout(ctx, text, mid, maxWidth, maxLines);
    if (lines) {
      best = { fontPx: mid, lines };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;

  // Nothing fits: hard-truncate with ellipsis at minimum size.
  ctx.font = `600 ${minPx}px ${FONT_FAMILY}`;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  const t = truncated + "…";
  return { fontPx: minPx, lines: [{ text: t, width: ctx.measureText(t).width }] };
}

export function renderTile(spec: TileSpec): Buffer {
  const key = cacheKey(["tile", spec]);
  const hit = cacheGet(key);
  if (hit) return hit;

  const S = TILE_SIZE;
  const theme = themeFor(spec.state);
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");

  // Background + rounded border
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = spec.selected ? SELECTED_BORDER : theme.border;
  ctx.lineWidth = spec.selected ? 8 : 4;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, S - ctx.lineWidth, S - ctx.lineWidth);

  const pad = 12;
  const maxWidth = S - pad * 2;
  const hasSub = Boolean(spec.subtext);

  // Main text: up to 3 lines, auto-fit.
  const { fontPx, lines } = fitText(ctx, spec.text, maxWidth, hasSub ? 2 : 3);
  ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
  ctx.fillStyle = theme.fg;
  ctx.textBaseline = "middle";
  const lineHeight = fontPx * 1.15;
  const blockHeight = lines.length * lineHeight;
  const centerY = hasSub ? (S - 30) / 2 : S / 2;
  lines.forEach((line, i) => {
    const y = centerY - blockHeight / 2 + lineHeight * (i + 0.5);
    ctx.fillText(line.text, (S - line.width) / 2, y);
  });

  // Subtext: one small line pinned near the bottom.
  if (spec.subtext) {
    ctx.font = `400 16px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.subFg;
    let sub = spec.subtext;
    while (sub.length > 1 && ctx.measureText(sub + "…").width > maxWidth) sub = sub.slice(0, -1);
    if (sub !== spec.subtext) sub += "…";
    ctx.fillText(sub, (S - ctx.measureText(sub).width) / 2, S - 20);
  }

  // Badge: small filled circle with short text, top-right.
  if (spec.badge) {
    const r = 16;
    const cx = S - r - 8;
    const cy = r + 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = theme.border;
    ctx.fill();
    ctx.font = `700 18px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.bg;
    const bw = ctx.measureText(spec.badge).width;
    ctx.fillText(spec.badge, cx - bw / 2, cy);
  }

  // Stale overlay: darken the whole tile (drawn last, under nothing).
  if (spec.dim) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, S, S);
  }

  const buf = canvas.toBuffer("image/png");
  cachePut(key, buf);
  return buf;
}

/**
 * Multi-key banner: renders one long string on a 144×(144·n) canvas and
 * slices it into n tile PNGs for adjacent keys.
 */
export function renderBanner(text: string, span: number, state: string): Buffer[] {
  const key = cacheKey(["banner", text, span, state]);
  const hit = cacheGet(key + ":0");
  if (hit) {
    const out: Buffer[] = [];
    for (let i = 0; i < span; i++) {
      const part = cacheGet(`${key}:${i}`);
      if (!part) break;
      out.push(part);
    }
    if (out.length === span) return out;
  }

  const S = TILE_SIZE;
  const W = S * span;
  const theme = themeFor(state);
  const canvas = createCanvas(W, S);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, S);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, S - 4);

  const pad = 16;
  const { fontPx, lines } = fitText(ctx, text, W - pad * 2, 3, 14, 34);
  ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
  ctx.fillStyle = theme.fg;
  ctx.textBaseline = "middle";
  const lineHeight = fontPx * 1.15;
  const blockHeight = lines.length * lineHeight;
  lines.forEach((line, i) => {
    const y = S / 2 - blockHeight / 2 + lineHeight * (i + 0.5);
    ctx.fillText(line.text, (W - line.width) / 2, y);
  });

  const out: Buffer[] = [];
  for (let i = 0; i < span; i++) {
    const slice = createCanvas(S, S);
    const sctx = slice.getContext("2d");
    sctx.drawImage(canvas, -i * S, 0);
    const buf = slice.toBuffer("image/png");
    cachePut(`${key}:${i}`, buf);
    out.push(buf);
  }
  return out;
}

export function toDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}
