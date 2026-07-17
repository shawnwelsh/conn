import { describe, expect, it } from "vitest";
import { AhkAdapter, chordToAhk } from "../src/delivery/ahk.js";
import { chordToSendKeys, escapeSendKeysText } from "../src/delivery/sendkeys.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

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

describe("dead bound-window handling (exact-target sessions never fall back)", () => {
  function stubbed(replies: (line: string) => string) {
    const adapter = new AhkAdapter("C:\\fake\\AutoHotkey64.exe", noopLog, "activeWindow");
    const calls: string[] = [];
    (adapter as unknown as { command: (line: string) => Promise<string> }).command = async (line) => {
      calls.push(line);
      return replies(line);
    };
    return { adapter, calls };
  }

  it("refuses delivery when the bound HWND is gone — no app-window fallback", async () => {
    const { adapter, calls } = stubbed((line) =>
      line.includes("ahk_id") ? "err|window not found" : "ok",
    );
    const ok = await adapter.focus({ sessionId: "s", cwd: "", label: "nimble badger", hwnd: 12345 });
    expect(ok).toBe(false);
    // Exactly one attempt, at the exact window — never the Claude app.
    expect(calls).toEqual(["focus|ahk_id 12345"]);
  });

  it("uses the bound HWND when alive", async () => {
    const { adapter, calls } = stubbed(() => "ok");
    const ok = await adapter.focus({ sessionId: "s", cwd: "", label: "x", hwnd: 777 });
    expect(ok).toBe(true);
    expect(calls).toEqual(["focus|ahk_id 777"]);
  });

  it("unbound sessions still use the activeWindow app fallback", async () => {
    const { adapter, calls } = stubbed(() => "ok");
    const ok = await adapter.focus({ sessionId: "s", cwd: "", label: "x" });
    expect(ok).toBe(true);
    expect(calls).toEqual(["focus|ahk_exe Claude.exe"]);
  });
});

describe("escapeSendKeysText", () => {
  it("escapes SendKeys metacharacters so literal text types verbatim", () => {
    expect(escapeSendKeysText("/save-work")).toBe("/save-work");
    expect(escapeSendKeysText("a+b(c)")).toBe("a{+}b{(}c{)}");
  });
});
