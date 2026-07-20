/** Generates minimal placeholder icons for the .sdPlugin bundle. */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("packages", "plugin", "com.shawnwelsh.belay.sdPlugin", "imgs");
mkdirSync(dir, { recursive: true });

function icon(size: number): Buffer {
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1e3a8a";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(size * 0.62)}px Segoe UI`;
  const text = "C";
  const w = ctx.measureText(text).width;
  ctx.textBaseline = "middle";
  ctx.fillText(text, (size - w) / 2, size / 2 + size * 0.03);
  return c.toBuffer("image/png");
}

writeFileSync(join(dir, "plugin-icon.png"), icon(256));
writeFileSync(join(dir, "plugin-icon@2x.png"), icon(512));
writeFileSync(join(dir, "action-icon.png"), icon(20));
writeFileSync(join(dir, "action-icon@2x.png"), icon(40));
console.log("icons written to", dir);
