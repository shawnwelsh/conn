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

  if (spec.icon) {
    // Icon layout: vector glyph on top, label + subtext beneath. The label
    // auto-fits on ONE line (long labels like "Deny + reason" shrink, then
    // ellipsize) — a fixed size overflows the tile.
    drawIcon(ctx, spec.icon, S / 2, S * 0.36, S * 0.2, theme.fg);
    const { fontPx, lines } = fitText(ctx, spec.text, maxWidth, 1, 12, 24);
    const line = lines[0]!;
    ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.fg;
    ctx.textBaseline = "middle";
    ctx.fillText(line.text, (S - line.width) / 2, S * 0.72);
  } else {
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
  }

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

  // Dead session: heavy darken + drawn skull-and-crossbones (vector, so it
  // can never fall back to a missing-glyph box).
  if (spec.dead) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, S, S);
    drawSkull(ctx, S / 2, S / 2 + 6, 34);
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

/** Simple vector icons for the global keys — drawn, never font glyphs, so
 * they can't tofu. (cx, cy) center, r ≈ half-size. */
function drawIcon(
  ctx: SKRSContext2D,
  icon: NonNullable<TileSpec["icon"]>,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = r * 0.22;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (icon) {
    case "mic": {
      // Capsule + stand.
      const w = r * 0.75;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - r, w, r * 1.3, w / 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.1, r * 0.75, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy + r * 0.85);
      ctx.lineTo(cx, cy + r * 1.2);
      ctx.stroke();
      break;
    }
    case "send": {
      // Paper plane.
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r * 0.7);
      ctx.lineTo(cx + r * 1.1, cy);
      ctx.lineTo(cx - r, cy + r * 0.7);
      ctx.lineTo(cx - r * 0.45, cy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "esc": {
      // Bold ✕.
      ctx.lineWidth = r * 0.32;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.8, cy - r * 0.8);
      ctx.lineTo(cx + r * 0.8, cy + r * 0.8);
      ctx.moveTo(cx + r * 0.8, cy - r * 0.8);
      ctx.lineTo(cx - r * 0.8, cy + r * 0.8);
      ctx.stroke();
      break;
    }
    case "new": {
      // Bold ＋.
      ctx.lineWidth = r * 0.32;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
      ctx.stroke();
      break;
    }
    case "page": {
      // Stacked pages.
      const w = r * 1.5;
      const h = r * 1.1;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2 + r * 0.35, cy - h / 2 - r * 0.35, w, h, r * 0.2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r * 0.2);
      ctx.fill();
      break;
    }
    case "menu": {
      // Three bars.
      ctx.lineWidth = r * 0.26;
      for (const dy of [-0.65, 0, 0.65]) {
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.9, cy + dy * r);
        ctx.lineTo(cx + r * 0.9, cy + dy * r);
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/** Vector skull-and-crossbones centered at (cx, cy); r ≈ skull radius. */
function drawSkull(ctx: SKRSContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.strokeStyle = "#f8fafc";
  ctx.fillStyle = "#f8fafc";
  ctx.lineCap = "round";

  // Crossed bones behind the skull.
  ctx.lineWidth = r * 0.28;
  const b = r * 1.55;
  for (const [x1, y1, x2, y2] of [
    [cx - b, cy - b * 0.55, cx + b, cy + b * 0.55],
    [cx - b, cy + b * 0.55, cx + b, cy - b * 0.55],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Bone knobs at each end.
    for (const [ex, ey] of [[x1, y1], [x2, y2]] as const) {
      ctx.beginPath();
      ctx.arc(ex, ey - r * 0.14, r * 0.16, 0, Math.PI * 2);
      ctx.arc(ex, ey + r * 0.14, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Cranium + jaw.
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.15, r, Math.PI * 0.95, Math.PI * 2.05);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.35, r * 0.62, r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eyes + nose (cut out of the skull).
  ctx.fillStyle = "#0a0a0a";
  for (const dx of [-0.42, 0.42]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx * r, cy - r * 0.12, r * 0.22, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.12);
  ctx.lineTo(cx - r * 0.12, cy + r * 0.38);
  ctx.lineTo(cx + r * 0.12, cy + r * 0.38);
  ctx.closePath();
  ctx.fill();

  // Teeth lines.
  ctx.strokeStyle = "#0a0a0a";
  ctx.lineWidth = r * 0.07;
  for (const dx of [-0.2, 0, 0.2]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * r, cy + r * 0.62);
    ctx.lineTo(cx + dx * r, cy + r * 0.86);
    ctx.stroke();
  }
  ctx.restore();
}
