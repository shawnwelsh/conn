import { describe, expect, it } from "vitest";
import { looksEnumerated } from "../src/optionReader.js";

describe("looksEnumerated (the gate that keeps the sidecar off your usage limits)", () => {
  it("fires on alternatives put to the reader", () => {
    expect(looksEnumerated("I can fold it into the existing flow, or stand it up separately?")).toBe(true);
    expect(looksEnumerated("Either we widen the APAC gate or add a fourth rule. Which?")).toBe(true);
    expect(
      looksEnumerated("Three ways in:\n\n1) patch the flow\n2) add a rule\n3) leave it\n\nWhich one?"),
    ).toBe(true);
  });

  it("stays off messages the free path already handles", () => {
    // A plain yes/no offer — the Accept key answers it, no model needed.
    expect(looksEnumerated("Want me to also wire the tests?")).toBe(false);
    // An open question — dictation answers it, no model needed.
    expect(looksEnumerated("Which context fields do you want in the line?")).toBe(false);
    // Not a question at all.
    expect(looksEnumerated("Done. Everything is committed and pushed.")).toBe(false);
  });

  it("is not fooled by an enumerated list of findings with no question", () => {
    // Verbatim shape from bridge.log: numbered EXPLANATION points, not
    // choices. Without a closing question there is nothing to pick.
    const msg = [
      "**1. Both filters must agree.** The start filter and the Decision.",
      "**2. Picklist type dictates the wrapper.** Single-select needs TEXT().",
      "**3. Blank context fields leave dangling separators.**",
    ].join("\n\n");
    expect(looksEnumerated(msg)).toBe(false);
  });

  it("ignores question marks inside code", () => {
    expect(looksEnumerated("Fixed:\n\n```\nconst x = a ? b : c;\n```\n\nAll green.")).toBe(false);
  });

  it("only reads the tail — an early aside is not the offer", () => {
    const msg = "Early on I wondered: patch it, or rewrite?\n\n" + "Detail. ".repeat(400) + "\n\nAll done, nothing outstanding.";
    expect(looksEnumerated(msg)).toBe(false);
  });
});
