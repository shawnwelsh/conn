import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import type { TileSpec, SessionStatus } from "@conn/shared";
import {
  themeFor,
  SELECTED_BORDER,
  TILE_SIZE,
  FONT_FAMILY,
  VEIL_ALPHA,
  VEIL_ALPHA_BREATH,
  TARGET_ALPHA_BREATH,
} from "./theme.js";

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
  /** Break an over-long single token character-wise instead of giving up.
   * ONLY the command banner wants this — tiles/labels keep the original
   * word-only wrap, so a long token there still just shrinks the font. */
  breakWords = false,
): Line[] | null {
  ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest) {
      const candidate = line ? `${line} ${rest}` : rest;
      if (fits(candidate)) {
        line = candidate;
        break;
      }
      if (line) {
        // Close this line and retry the word fresh on the next one.
        lines.push(line);
        if (lines.length === maxLines) return null;
        line = "";
        continue;
      }
      // Fresh line and the word alone overflows.
      if (!breakWords) return null; // original behaviour: let fitText shrink the font
      // Banner only: break the token, taking the largest prefix that fits and
      // carrying the remainder to the next line (no space inserted mid-token).
      let fit = 1;
      let lo = 1;
      let hi = rest.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(rest.slice(0, mid))) {
          fit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      lines.push(rest.slice(0, fit));
      if (lines.length === maxLines) return null;
      rest = rest.slice(fit);
    }
  }
  if (line) {
    if (lines.length === maxLines) return null;
    lines.push(line);
  }
  return lines.length ? lines.map((t) => ({ text: t, width: ctx.measureText(t).width })) : null;
}

/** Binary-search the largest font size whose wrap fits maxLines; falls back
 * to minimum size + ellipsis. Exported for wrap tests. */
export function fitText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  minPx = 14,
  maxPx = 40,
  breakWords = false,
): { fontPx: number; lines: Line[] } {
  let lo = minPx;
  let hi = maxPx;
  let best: { fontPx: number; lines: Line[] } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = tryLayout(ctx, text, mid, maxWidth, maxLines, breakWords);
    if (lines) {
      best = { fontPx: mid, lines };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;

  // Too long for maxLines even at the floor font. Wrap the WHOLE thing at
  // minPx (unbounded), keep the first maxLines lines, and ellipsize the last —
  // so a huge command fills all the lines it's given (3 × ~90 chars) instead
  // of collapsing to a single ~90-char line. For tiles (breakWords=false) an
  // over-long single token still can't wrap, so this yields one line, same as
  // before; only the banner benefits.
  ctx.font = `600 ${minPx}px ${FONT_FAMILY}`;
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const all = tryLayout(ctx, text, minPx, maxWidth, Number.MAX_SAFE_INTEGER, breakWords);
  if (all && all.length) {
    const shown = all.slice(0, maxLines);
    if (all.length > maxLines) {
      let last = shown[shown.length - 1]!.text;
      while (last.length > 1 && !fits(last + "…")) last = last.slice(0, -1);
      shown[shown.length - 1] = { text: `${last}…`, width: ctx.measureText(`${last}…`).width };
    }
    return { fontPx: minPx, lines: shown };
  }

  // Degenerate (a single unbreakable token, e.g. a tile label): one line, cut.
  let truncated = text;
  while (truncated.length > 1 && !fits(`${truncated}…`)) truncated = truncated.slice(0, -1);
  return { fontPx: minPx, lines: [{ text: `${truncated}…`, width: ctx.measureText(`${truncated}…`).width }] };
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
  //
  // Sized for the PANEL, not the canvas. Tiles render at 144px and the deck
  // downscales them to a 72px LCD, so every dimension here is effectively
  // halved — 16px thin rendered as 8px on glass, which reads as "very fine"
  // in the hand. Weight matters more than size at that scale: a semibold
  // stroke survives the downsample where a 400 hairline dissolves.
  if (spec.subtext) {
    // Keep clear of the ›_ corner mark, which shares this baseline.
    const left = spec.promptMark ? 38 : pad;
    const subWidth = S - left - pad;
    // Auto-fit rather than one fixed size: "2 pending" gets the full 20px,
    // "name + branch" shrinks to fit instead of ellipsizing. Losing the words
    // is worse than losing a couple of points — the subtext is where a key
    // says what it will actually do.
    const { fontPx } = fitText(ctx, spec.subtext, subWidth, 1, 14, 20);
    ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
    ctx.fillStyle = theme.subFg;
    // Only pay for the ellipsis if it's actually needed. Measuring
    // `sub + "…"` up front charged every string for a character it wasn't
    // going to use, clipping text that fit perfectly well: "2 pending" is
    // 92px in a 94px box, but 106px once an unnecessary ellipsis is added.
    let sub = spec.subtext;
    if (ctx.measureText(sub).width > subWidth) {
      while (sub.length > 1 && ctx.measureText(sub + "…").width > subWidth) sub = sub.slice(0, -1);
      sub += "…";
    }
    ctx.fillText(sub, left + (subWidth - ctx.measureText(sub).width) / 2, S - 20);
  }

  // Status as a SHAPE, top-right — the second channel alongside colour.
  // idle draws nothing: an always-present mark stops being a signal.
  if (spec.statusMark && spec.statusMark !== "idle") {
    const r = 16;
    const cx = S - r - 8;
    const cy = r + 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = theme.border;
    ctx.fill();
    drawStatusMark(ctx, spec.statusMark, cx, cy, r * 0.8, theme.bg);
  }

  // Console tell, bottom-left and deliberately quiet.
  if (spec.promptMark) drawPromptMark(ctx, 20, S - 20, 11, theme.subFg);

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

  // Stale: drain the COLOUR, keep the brightness. Darkening it would say the
  // same thing as "not targeted" and the two states would be unreadable
  // together; a grey key among coloured ones says "old news" on its own.
  if (spec.dim) {
    ctx.save();
    ctx.globalCompositeOperation = "saturation";
    ctx.fillStyle = "hsl(0, 0%, 50%)";
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
  }

  // Dead session: a white skull on near-black — its own channel entirely, so
  // "gone" can't be read as merely dim (not targeted) or grey (stale). The
  // wash is heavy so the label recedes and the skull is the whole message.
  if (spec.dead) {
    const bg = "#0a0a0a";
    ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
    ctx.fillRect(0, 0, S, S);
    drawSkull(ctx, S / 2, S / 2 + 4, 32, "#f8fafc", bg);
  }

  // Not the targeted session: veil it. LAST, so it dims the skull too — a
  // dead session you aren't pointed at should recede like every other
  // non-target, not glow brighter than the live one you're driving.
  //
  // `pulse` breathes that veil on the slow clock for a session blocked on a
  // prompt the deck can't answer. It only ever moves between dim and dimmer:
  // the bright end stays clearly darker than an unveiled key, because full
  // brightness is reserved for "this is where your keystrokes go" and must not
  // be borrowed by a key that merely wants attention. A targeted session gets
  // the same breath as a light wash, so the cue is visible on every key.
  if (spec.veil) {
    ctx.fillStyle = `rgba(0, 0, 0, ${spec.pulse ? VEIL_ALPHA_BREATH : VEIL_ALPHA})`;
    ctx.fillRect(0, 0, S, S);
  } else if (spec.pulse) {
    ctx.fillStyle = `rgba(0, 0, 0, ${TARGET_ALPHA_BREATH})`;
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
  // breakWords: the banner shows commands with long space-less tokens (paths,
  // `&&` chains); break them across lines rather than shrink to a tiny font.
  const { fontPx, lines } = fitText(ctx, text, W - pad * 2, 3, 14, 34, true);
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
    case "resume": {
      // Open circular arrow — "pick up where you left off". Deliberately not
      // a play triangle, which would read as a sibling of the Send plane.
      // The head is built from the arc's own tangent and normal at its end
      // point, so it sits ON the curve pointing the way it travels; offsets
      // guessed by eye just look broken.
      const rr = r * 0.8;
      const a0 = Math.PI * 0.3;
      const a1 = Math.PI * 1.95; // ~60° gap where the head goes
      ctx.lineWidth = r * 0.24;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, a0, a1);
      ctx.stroke();

      const px = cx + Math.cos(a1) * rr;
      const py = cy + Math.sin(a1) * rr;
      const tx = -Math.sin(a1); // tangent, in the direction of travel
      const ty = Math.cos(a1);
      const nx = Math.cos(a1); // outward normal
      const ny = Math.sin(a1);
      const len = r * 0.52;
      const wid = r * 0.34;
      ctx.beginPath();
      ctx.moveTo(px + tx * len, py + ty * len); // tip
      ctx.lineTo(px + nx * wid, py + ny * wid);
      ctx.lineTo(px - nx * wid, py - ny * wid);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "fork": {
      // Two paths diverging from one — the conversation continues here AND
      // over there. Read against "branch" below: no nodes, symmetric split.
      ctx.lineWidth = r * 0.24;
      ctx.beginPath();
      ctx.moveTo(cx, cy + r);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - r * 0.85, cy - r * 0.9);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + r * 0.85, cy - r * 0.9);
      ctx.stroke();
      for (const dx of [-0.85, 0.85]) {
        ctx.beginPath();
        ctx.arc(cx + dx * r, cy - r * 0.9, r * 0.26, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "branch": {
      // Git-style: a trunk with one offshoot curving away — asymmetric, so
      // it can't be mistaken for the fork's even split.
      ctx.lineWidth = r * 0.24;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.55, cy - r);
      ctx.lineTo(cx - r * 0.55, cy + r);
      ctx.stroke();
      ctx.beginPath(); // offshoot leaving the trunk and levelling off
      ctx.moveTo(cx - r * 0.55, cy + r * 0.15);
      ctx.quadraticCurveTo(cx + r * 0.55, cy + r * 0.15, cx + r * 0.55, cy - r * 0.45);
      ctx.stroke();
      for (const [px, py] of [
        [cx - r * 0.55, cy - r],
        [cx - r * 0.55, cy + r],
        [cx + r * 0.55, cy - r * 0.55],
      ] as const) {
        ctx.beginPath();
        ctx.arc(px, py, r * 0.26, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "trash": {
      // A bin: handle, lid, tapered body with ribs. Note what this key does —
      // it takes sessions OFF THE DECK; it does not end them (they keep running
      // and return the moment you type into one). The bin was chosen over a
      // broom because its silhouette survives the 72px downscale unmistakably,
      // and the cohort menu's "hide …" subtexts carry the non-destructive part.
      ctx.save();
      ctx.translate(cx, cy);
      // Handle above the lid.
      ctx.lineWidth = r * 0.16;
      ctx.beginPath();
      ctx.moveTo(-r * 0.26, -r * 0.74);
      ctx.lineTo(-r * 0.26, -r * 0.96);
      ctx.lineTo(r * 0.26, -r * 0.96);
      ctx.lineTo(r * 0.26, -r * 0.74);
      ctx.stroke();
      // Lid.
      ctx.lineWidth = r * 0.2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.94, -r * 0.68);
      ctx.lineTo(r * 0.94, -r * 0.68);
      ctx.stroke();
      // Body: tapering slightly, rounded into the base.
      ctx.lineWidth = r * 0.18;
      ctx.beginPath();
      ctx.moveTo(-r * 0.76, -r * 0.4);
      ctx.lineTo(-r * 0.56, r * 0.84);
      ctx.quadraticCurveTo(-r * 0.52, r * 1.06, -r * 0.3, r * 1.06);
      ctx.lineTo(r * 0.3, r * 1.06);
      ctx.quadraticCurveTo(r * 0.52, r * 1.06, r * 0.56, r * 0.84);
      ctx.lineTo(r * 0.76, -r * 0.4);
      ctx.stroke();
      // Ribs, following the taper.
      ctx.lineWidth = r * 0.13;
      for (const [xTop, xBot] of [
        [-0.32, -0.26],
        [0, 0],
        [0.32, 0.26],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(r * xTop, -r * 0.14);
        ctx.lineTo(r * xBot, r * 0.72);
        ctx.stroke();
      }
      ctx.restore();
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
/**
 * Status shapes. Vector, never font glyphs — a missing glyph renders as a
 * tofu box, and a key that shows a box is worse than a key that shows
 * nothing. Sized for a 32px badge circle, where fine detail disappears:
 * "thinking" is three dots rather than a thought bubble because the bubble's
 * tail dots vanish entirely at this size.
 */
function drawStatusMark(
  ctx: SKRSContext2D,
  status: SessionStatus,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (status === "thinking") {
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(cx + i * r * 0.62, cy, r * 0.17, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (status === "waiting") {
    // The one status that means "come here" gets the loudest shape.
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.62);
    ctx.lineTo(cx, cy + r * 0.12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.56, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  } else if (status === "done") {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy);
    ctx.lineTo(cx - r * 0.12, cy + r * 0.45);
    ctx.lineTo(cx + r * 0.58, cy - r * 0.45);
    ctx.stroke();
  } else if (status === "error") {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.5);
    ctx.moveTo(cx + r * 0.5, cy - r * 0.5);
    ctx.lineTo(cx - r * 0.5, cy + r * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/** The ›_ console tell, drawn rather than typed. */
function drawPromptMark(ctx: SKRSContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, r * 0.2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.55, cy - r * 0.4);
  ctx.lineTo(cx - r * 0.1, cy);
  ctx.lineTo(cx - r * 0.55, cy + r * 0.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.1, cy + r * 0.42);
  ctx.lineTo(cx + r * 0.6, cy + r * 0.42);
  ctx.stroke();
  ctx.restore();
}

function drawSkull(ctx: SKRSContext2D, cx: number, cy: number, r: number, color = "#f8fafc", hollow = "#0a0a0a"): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";

  // Crossed bones behind the skull.
  ctx.lineWidth = r * 0.26;
  const b = r * 1.55;
  for (const [x1, y1, x2, y2] of [
    [cx - b, cy - b * 0.55, cx + b, cy + b * 0.55],
    [cx - b, cy + b * 0.55, cx + b, cy - b * 0.55],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Two knobs at each end, splayed PERPENDICULAR to the bone (a femur's
    // epiphysis) — offsetting them in y made the pair vertical no matter which
    // way the bone ran.
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len; // unit normal to the bone's axis
    const py = dx / len;
    const off = r * 0.18;
    for (const [ex, ey] of [[x1, y1], [x2, y2]] as const) {
      for (const s of [-1, 1] as const) {
        ctx.beginPath();
        ctx.arc(ex + px * off * s, ey + py * off * s, r * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Cranium — an upright oval (egg), taller than wide, not a dome; the jaw is
  // a narrower bump tucked under it.
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.05, r * 0.8, r * 1.02, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.5, cy + r * 0.5);
  ctx.quadraticCurveTo(cx - r * 0.5, cy + r * 0.98, cx, cy + r * 0.98);
  ctx.quadraticCurveTo(cx + r * 0.5, cy + r * 0.98, cx + r * 0.5, cy + r * 0.5);
  ctx.closePath();
  ctx.fill();

  // Eyes + nose (cut out of the skull).
  ctx.fillStyle = hollow;
  for (const dx of [-0.4, 0.4]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx * r, cy - r * 0.15, r * 0.24, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.08);
  ctx.lineTo(cx - r * 0.12, cy + r * 0.34);
  ctx.lineTo(cx + r * 0.12, cy + r * 0.34);
  ctx.closePath();
  ctx.fill();

  // Teeth lines.
  ctx.strokeStyle = hollow;
  ctx.lineWidth = r * 0.07;
  for (const dx of [-0.22, 0, 0.22]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * r, cy + r * 0.56);
    ctx.lineTo(cx + dx * r, cy + r * 0.92);
    ctx.stroke();
  }
  ctx.restore();
}
