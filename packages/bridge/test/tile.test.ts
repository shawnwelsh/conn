import { describe, expect, it } from "vitest";
import { renderTile, renderBanner } from "../src/render/tile.js";

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
