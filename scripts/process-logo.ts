/**
 * Generates every Conn brand asset from the master wordmark (black \CONN on
 * white, docs/brand/conn-wordmark.png):
 *
 *  - docs/conn-logo.png            transparent, ink       (light backgrounds)
 *  - docs/conn-logo-dark.png       transparent, near-white (dark backgrounds)
 *  - docs/conn-screensaver-480x272.png   the deck screensaver (mark on white)
 *
 * …and embeds the ink version into the showcase hero as a data URI. The web
 * page inverts the ink one via CSS for its dark theme; GitHub can't run CSS, so
 * the README swaps the pair with <picture> + prefers-color-scheme.
 *
 * White → transparent with alpha from luminance, so anti-aliased edges survive.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs scripts/process-logo.ts [sourcePng]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const source = process.argv[2] ?? join(docs, "brand", "conn-wordmark.png");

const img = await loadImage(readFileSync(source));
const src = createCanvas(img.width, img.height);
const sctx = src.getContext("2d");
sctx.drawImage(img, 0, 0);
const sdata = sctx.getImageData(0, 0, img.width, img.height).data;
const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

// Bounding box of the dark mark — trim the white field around it.
let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    if (sdata[i + 3]! > 20 && lum(sdata, i) < 160) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const cw = maxX - minX + 1;
const ch = maxY - minY + 1;

/** The trimmed mark, scaled to `targetW`, white knocked out to transparent and
 * the ink repainted `rgb`. */
function transparentMark(targetW: number, rgb: [number, number, number]): Buffer {
  const tw = targetW;
  const th = Math.round(ch * (targetW / cw));
  const c = createCanvas(tw, th);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, minX, minY, cw, ch, 0, 0, tw, th);
  const d = ctx.getImageData(0, 0, tw, th);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i + 3] = Math.max(0, Math.min(255, Math.round(255 - lum(p, i))));
    p[i] = rgb[0];
    p[i + 1] = rgb[1];
    p[i + 2] = rgb[2];
  }
  ctx.putImageData(d, 0, 0);
  return c.toBuffer("image/png");
}

/** The deck screensaver: the mark, big, on a solid white field (matching the
 * logo). 480×272 renders across the 5×3 keys, so one wide form is the point. */
function screensaver(W = 480, H = 272, widthFrac = 0.86): Buffer {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const mw = W * widthFrac;
  const mh = mw * (ch / cw);
  ctx.drawImage(src, minX, minY, cw, ch, (W - mw) / 2, (H - mh) / 2, mw, mh);
  return c.toBuffer("image/png");
}

const inkPng = transparentMark(920, [20, 20, 19]);
writeFileSync(join(docs, "conn-logo.png"), inkPng);
writeFileSync(join(docs, "conn-logo-dark.png"), transparentMark(920, [237, 237, 238]));
writeFileSync(join(docs, "conn-screensaver-480x272.png"), screensaver());

// Embed the ink mark into the showcase hero so the page can't show a broken img.
const htmlPath = join(docs, "showcase.html");
const dataUri = "data:image/png;base64," + inkPng.toString("base64");
const html = readFileSync(htmlPath, "utf8").replace(/(<img class="wordmark" src=")[^"]*(")/, `$1${dataUri}$2`);
writeFileSync(htmlPath, html);

console.log("wrote conn-logo.png, conn-logo-dark.png, conn-screensaver-480x272.png; embedded into showcase.html");
