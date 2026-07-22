import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { renderTile, renderBanner, fitText } from "../src/render/tile.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("tile renderer", () => {
  it("renders a PNG", () => {
    const buf = renderTile({ text: "Allow", state: "answer" });
    expect(buf.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  it("returns the identical cached buffer for identical specs", () => {
    const a = renderTile({ text: "revops-platform", subtext: "thinking", state: "thinking" });
    const b = renderTile({ text: "revops-platform", subtext: "thinking", state: "thinking" });
    expect(a).toBe(b); // same object → cache hit, no re-render
  });

  it("survives real permission/question strings without throwing", () => {
    const realStrings = [
      "Yes, and don't ask again",
      "AutoHotkey v2 daemon (Recommended)",
      "Bash: git push --force-with-lease origin feature/sfdc-quote-fix-2026-07-16",
      "npm install --workspaces --include-workspace-root",
      "Supercalifragilisticexpialidocious-unbreakable-single-token",
    ];
    for (const text of realStrings) {
      const buf = renderTile({ text, state: "answer" });
      expect(buf.length).toBeGreaterThan(500);
    }
  });

  it("icon tiles auto-fit long labels (Deny + reason regression)", () => {
    // Fixed-size icon labels overflowed the tile; now they shrink to one line.
    for (const text of ["Deny + reason", "A very long icon key label indeed"]) {
      const buf = renderTile({ text, subtext: "dictate", state: "answer", icon: "mic" });
      expect(buf.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    }
  });

  it("slices banners into the requested span", () => {
    const parts = renderBanner("A long command being approved across keys", 3, "waiting");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});

describe("fitText wraps long unbreakable tokens instead of shrinking to fit", () => {
  const ctx = createCanvas(2, 2).getContext("2d");

  it("breaks a space-less path across lines, no ellipsis, larger than the floor", () => {
    // A bash path is one long 'word' — the old layout shrank the whole banner
    // to whatever font let that token sit on one line (tiny). Now it wraps.
    const path = "C:/dev/revops-platform/.claude/worktrees/quiet-vole/node_modules/.cache";
    const { fontPx, lines } = fitText(ctx, path, 240, 3, 14, 34);
    expect(lines.length).toBeGreaterThan(1); // the token was broken across lines
    expect(lines.map((l) => l.text).join("")).toBe(path); // chunks reassemble exactly
    expect(lines.some((l) => l.text.includes("…"))).toBe(false); // nothing truncated
    expect(fontPx).toBeGreaterThan(14); // and it isn't pinned at the minimum
  });

  it("still wraps a normal command on spaces", () => {
    const { lines } = fitText(ctx, "npm run build --workspace bridge", 240, 3, 14, 34);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Space-joined words keep their spaces; reassembling with spaces matches.
    expect(lines.map((l) => l.text).join(" ")).toBe("npm run build --workspace bridge");
  });

  it("a single token far too long for even maxLines still returns (truncated), never throws", () => {
    const huge = "x".repeat(4000);
    const { lines } = fitText(ctx, huge, 240, 3, 14, 34);
    expect(lines.length).toBeGreaterThan(0);
  });
});
