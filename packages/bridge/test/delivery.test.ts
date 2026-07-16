import { describe, expect, it } from "vitest";
import { chordToAhk } from "../src/delivery/ahk.js";
import { chordToSendKeys, escapeSendKeysText } from "../src/delivery/sendkeys.js";

describe("chordToAhk (AutoHotkey v2 Send syntax)", () => {
  it("maps named keys and modifiers", () => {
    expect(chordToAhk("enter")).toBe("{Enter}");
    expect(chordToAhk("escape")).toBe("{Esc}");
    expect(chordToAhk("shift+tab")).toBe("+{Tab}");
    expect(chordToAhk("ctrl+n")).toBe("^n");
    expect(chordToAhk("2")).toBe("2");
  });
});

describe("chordToSendKeys (WScript.Shell SendKeys syntax)", () => {
  it("maps named keys and modifiers", () => {
    expect(chordToSendKeys("enter")).toBe("{ENTER}");
    expect(chordToSendKeys("shift+tab")).toBe("+{TAB}");
    expect(chordToSendKeys("ctrl+n")).toBe("^n");
  });
});

describe("escapeSendKeysText", () => {
  it("escapes SendKeys metacharacters so literal text types verbatim", () => {
    expect(escapeSendKeysText("/save-work")).toBe("/save-work");
    expect(escapeSendKeysText("a+b(c)")).toBe("a{+}b{(}c{)}");
  });
});
