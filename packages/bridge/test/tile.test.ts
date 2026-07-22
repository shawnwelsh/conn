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

describe("fitText breakWords is opt-in: banner wraps long tokens, tiles don't", () => {
  const ctx = createCanvas(2, 2).getContext("2d");
  const path = "C:/dev/revops-platform/.claude/worktrees/quiet-vole/node_modules/.cache";

  it("with breakWords (the banner): a space-less path breaks across lines, no ellipsis", () => {
    const { fontPx, lines } = fitText(ctx, path, 240, 3, 14, 34, true);
    expect(lines.length).toBeGreaterThan(1); // token broken across lines
    expect(lines.map((l) => l.text).join("")).toBe(path); // reassembles exactly
    expect(lines.some((l) => l.text.includes("…"))).toBe(false);
    expect(fontPx).toBeGreaterThan(14); // not pinned at the floor
  });

  it("WITHOUT breakWords (tiles/buttons): the token is NEVER broken — it shrinks or ellipsizes", () => {
    // This is the regression the user caught: buttons/labels must keep the
    // original word-only wrap, so a long token stays intact.
    const { lines } = fitText(ctx, path, 240, 3, 14, 34, false);
    // Either a single (possibly ellipsized) line, or space-split — but no
    // line is a bare mid-token fragment of the path.
    for (const l of lines) {
      const isFragment = path.includes(l.text) && l.text !== path && !l.text.includes("…");
      expect(isFragment).toBe(false);
    }
  });

  it("normal command wraps on spaces regardless of breakWords", () => {
    for (const bw of [false, true]) {
      const { lines } = fitText(ctx, "npm run build --workspace bridge", 240, 3, 14, 34, bw);
      expect(lines.map((l) => l.text).join(" ")).toBe("npm run build --workspace bridge");
    }
  });

  it("a pathological token still returns without throwing (both modes)", () => {
    for (const bw of [false, true]) {
      const { lines } = fitText(ctx, "x".repeat(4000), 240, 3, 14, 34, bw);
      expect(lines.length).toBeGreaterThan(0);
    }
  });
});
