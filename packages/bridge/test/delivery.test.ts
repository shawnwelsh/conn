import { describe, expect, it } from "vitest";
import { AhkAdapter, chordToAhk, chordToVt, pctEncode } from "../src/delivery/ahk.js";
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

  it("delivers to a bound console via its exact HWND (ControlSend daemon-side)", async () => {
    const { adapter, calls } = stubbed(() => "ok");
    const ok = await adapter.sendKey({ sessionId: "s", cwd: "", label: "x", hwnd: 42 }, "escape");
    expect(ok).toBe(true);
    expect(calls).toEqual(["key|ahk_id 42|{Esc}"]);
  });

  it("distinguishes gone / noactivate / timeout, none falling back to the app", async () => {
    for (const reply of ["err|gone", "err|noactivate", "err|timeout"]) {
      const { adapter, calls } = stubbed(() => reply);
      const ok = await adapter.sendKey({ sessionId: "s", cwd: "", label: "x", hwnd: 42 }, "enter");
      expect(ok).toBe(false);
      expect(calls).toEqual(["key|ahk_id 42|{Enter}"]); // exact window only
    }
  });
});

describe("escapeSendKeysText", () => {
  it("escapes SendKeys metacharacters so literal text types verbatim", () => {
    expect(escapeSendKeysText("/save-work")).toBe("/save-work");
    expect(escapeSendKeysText("a+b(c)")).toBe("a{+}b{(}c{)}");
  });
});

describe("chordToVt (raw-mode console byte sequences)", () => {
  it("maps keys to their VT bytes; desktop-only chords map to null", () => {
    expect(chordToVt("enter")).toBe("\r");
    expect(chordToVt("escape")).toBe("\x1b");
    expect(chordToVt("shift+tab")).toBe("\x1b[Z");
    expect(chordToVt("up")).toBe("\x1b[A");
    expect(chordToVt("2")).toBe("2");
    expect(chordToVt("ctrl+c")).toBe("\x03");
    expect(chordToVt("ctrl+shift+m")).toBeNull();
    expect(chordToVt("ctrl+shift+i")).toBeNull();
  });
});

describe("pctEncode (conwrite payload)", () => {
  it("escapes control bytes, %, and | — plain text passes through", () => {
    expect(pctEncode("/status")).toBe("/status");
    expect(pctEncode("\r")).toBe("%0D");
    expect(pctEncode("\x1b[Z")).toBe("%1B[Z");
    expect(pctEncode("50%|a")).toBe("50%25%7Ca");
  });
});

describe("console delivery via input-buffer injection (pid-bound sessions)", () => {
  function stubbed(reply = "ok") {
    const adapter = new AhkAdapter("C:\\fake\\AutoHotkey64.exe", noopLog, "activeWindow");
    const calls: string[] = [];
    (adapter as unknown as { command: (line: string) => Promise<string> }).command = async (line) => {
      calls.push(line);
      return reply;
    };
    return { adapter, calls };
  }
  // Reply depends on the command — for the window-recovery paths, which fan out
  // to findpid / findtitle before acting.
  function probe(replies: (line: string) => string) {
    const adapter = new AhkAdapter("C:\\fake\\AutoHotkey64.exe", noopLog, "activeWindow");
    const calls: string[] = [];
    (adapter as unknown as { command: (line: string) => Promise<string> }).command = async (line) => {
      calls.push(line);
      return replies(line);
    };
    return { adapter, calls };
  }
  const con = { sessionId: "s", cwd: "", label: "keen marten", hwnd: 42, pid: 9 };

  it("text and VT-mappable keys inject by pid — never the window", async () => {
    const { adapter, calls } = stubbed();
    await adapter.sendText(con, "/status");
    await adapter.sendKey(con, "enter");
    await adapter.sendKey(con, "shift+tab");
    expect(calls).toEqual(["conwrite|9|/status", "conwrite|9|%0D", "conwrite|9|%1B[Z"]);
  });

  it("desktop-only chords fall back to the window path", async () => {
    const { adapter, calls } = stubbed();
    await adapter.sendKey(con, "ctrl+shift+m");
    expect(calls).toEqual(["key|ahk_id 42|^+m"]);
  });

  it("a dead console process is a refusal — no app fallback", async () => {
    const { adapter, calls } = stubbed("err|gone");
    const ok = await adapter.sendText(con, "hello");
    expect(ok).toBe(false);
    expect(calls).toEqual(["conwrite|9|hello"]);
  });

  it("focus still uses the window (injection can't surface)", async () => {
    const { adapter, calls } = stubbed();
    await adapter.focus(con);
    expect(calls).toEqual(["focus|ahk_id 42"]);
  });

  it("a pid-only console with no window tries to re-find one, then refuses — never the app", async () => {
    const { adapter, calls } = probe((line) =>
      line.startsWith("findpid") || line.startsWith("findtitle") ? "hwnd|0" : "ok",
    );
    const c = { sessionId: "s", cwd: "C:\\dev\\nimble-otter", label: "nimble otter", pid: 36588 }; // no hwnd
    expect(await adapter.focus(c)).toBe(false);
    // Re-find attempted — pid first (conhost), then title constrained to WT —
    // but it NEVER falls through to the Claude desktop app.
    expect(calls).toEqual(["findpid|36588", "findtitle|nimble-otter ahk_exe WindowsTerminal.exe"]);
    expect(calls).not.toContain("focus|ahk_exe Claude.exe");
    // …but it still takes keystrokes, which is the point of a pid binding.
    calls.length = 0;
    await adapter.sendText(c, "/status");
    expect(calls).toEqual(["conwrite|36588|/status"]);
  });

  it("re-finds a moved console's window by its Claude Code name and focuses + maximizes it", async () => {
    // The reported bug: a WT tab dragged to another window keeps taking
    // commands (pid) but lost the handle focus/maximize need. Claude Code
    // renamed the tab "Renewal Fix", so that title still resolves the window.
    const { adapter, calls } = probe((line) =>
      line.startsWith("findpid") ? "hwnd|0" : line.startsWith("findtitle") ? "hwnd|88" : "ok",
    );
    const moved = { sessionId: "s", cwd: "C:\\dev\\worktrees\\brisk-wombat", label: "brisk wombat", pid: 42200, ccName: "Renewal Fix" };
    expect(await adapter.focus(moved)).toBe(true);
    expect(calls).toEqual([
      "findpid|42200",
      "findtitle|Renewal Fix ahk_exe WindowsTerminal.exe",
      "focus|ahk_id 88",
    ]);
    calls.length = 0;
    expect(await adapter.setWindowState(moved, "maximize")).toBe(true);
    expect(calls).toEqual([
      "findpid|42200",
      "findtitle|Renewal Fix ahk_exe WindowsTerminal.exe",
      "winstate|ahk_id 88|max",
    ]);
  });

  it("with no Claude Code name, the title hunt uses the launch codename (cwd leaf)", async () => {
    const { adapter, calls } = probe((line) =>
      line.startsWith("findpid") ? "hwnd|0" : line.startsWith("findtitle") ? "hwnd|91" : "ok",
    );
    const moved = { sessionId: "s", cwd: "C:\\dev\\worktrees\\brisk-wombat", label: "brisk wombat", pid: 42200 };
    expect(await adapter.focus(moved)).toBe(true);
    expect(calls).toEqual([
      "findpid|42200",
      "findtitle|brisk-wombat ahk_exe WindowsTerminal.exe",
      "focus|ahk_id 91",
    ]);
  });

  it("a classic conhost console re-finds its window by pid — no title hunt", async () => {
    // conhost windows belong to the cmd child, so the pid resolves them
    // exactly; the title fallback is never reached.
    const { adapter, calls } = probe((line) => (line.startsWith("findpid") ? "hwnd|77" : "ok"));
    const c = { sessionId: "s", cwd: "C:\\dev\\x", label: "x", pid: 500 }; // no hwnd
    expect(await adapter.focus(c)).toBe(true);
    expect(calls).toEqual(["findpid|500", "focus|ahk_id 77"]);
  });
});
