import { describe, expect, it, vi, afterEach } from "vitest";
import { DecisionStore, deriveAlwaysRule, summarizeToolInput } from "../src/decisions.js";
import type { AnyHookEvent } from "../src/hookTypes.js";

const noopLog = { info: () => {}, warn: () => {}, debug: () => {} } as never;

function permEvent(sessionId = "s1", command = "git status"): AnyHookEvent {
  return {
    session_id: sessionId,
    cwd: "C:\\dev\\x",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command },
  };
}

function makeStore(opts: { clients?: boolean; timeoutMs?: number; dest?: "session" | "localSettings" } = {}) {
  return new DecisionStore(
    opts.timeoutMs ?? 30_000,
    noopLog,
    () => opts.clients ?? true,
    () => {},
    opts.dest ?? "session",
  );
}

afterEach(() => vi.useRealTimers());

describe("AskUserQuestion is never held", () => {
  it("passes straight through so the question layer — not Allow/Deny — answers it", async () => {
    const changes: string[] = [];
    const store = new DecisionStore(30_000, noopLog, () => true, () => changes.push("changed"), "session");
    const body = await store.hold({
      session_id: "s1",
      cwd: "C:\\dev\\x",
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] },
    } as AnyHookEvent);
    // Resolved at once, nothing queued, no permission morph raised.
    expect(body).toEqual({});
    expect(store.current).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it("still holds ordinary tools", async () => {
    const store = makeStore();
    let settled = false;
    void store.hold(permEvent()).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(store.current?.toolName).toBe("Bash");
  });
});

describe("DecisionStore safety invariants", () => {
  it("defers immediately (empty body) when no deck clients are connected", async () => {
    const store = makeStore({ clients: false });
    await expect(store.hold(permEvent())).resolves.toEqual({});
    expect(store.current).toBeUndefined();
  });

  it("resolves {} on timeout — never allow, never deny", async () => {
    vi.useFakeTimers();
    const store = makeStore({ timeoutMs: 5000 });
    const held = store.hold(permEvent());
    vi.advanceTimersByTime(5001);
    await expect(held).resolves.toEqual({});
  });

  it("only a key press produces an allow", async () => {
    const store = makeStore();
    const held = store.hold(permEvent());
    store.decide("allow");
    const body = (await held) as any;
    expect(body.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(body.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
  });

  it("show-on-screen releases with {} so the normal dialog appears", async () => {
    const store = makeStore();
    const held = store.hold(permEvent());
    store.decide("show-on-screen");
    await expect(held).resolves.toEqual({});
  });

  it("releaseSession frees a dead session's request to the normal flow", async () => {
    const store = makeStore();
    const held = store.hold(permEvent("dying"));
    store.releaseSession("dying");
    await expect(held).resolves.toEqual({});
  });

  it("queues concurrent requests and surfaces them one at a time", async () => {
    const store = makeStore();
    const first = store.hold(permEvent("s1", "cmd-one"));
    const second = store.hold(permEvent("s2", "cmd-two"));
    expect(store.current?.sessionId).toBe("s1");
    store.decide("deny");
    expect(store.current?.sessionId).toBe("s2");
    store.decide("allow");
    const b1 = (await first) as any;
    const b2 = (await second) as any;
    expect(b1.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(b2.hookSpecificOutput.decision.behavior).toBe("allow");
  });
});

describe("always-allow rule derivation stays narrow", () => {
  it("Bash → exact command rule in CC's PermissionUpdate shape", async () => {
    const store = makeStore({ dest: "session" });
    const held = store.hold(permEvent("s1", "npm run build"));
    store.decide("always-allow");
    const body = (await held) as any;
    // Shape verified against the CC 2.1.211 binary (addRules variant).
    expect(body.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(body.hookSpecificOutput.decision.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "Bash(npm run build)" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("honors the configured destination", async () => {
    const store = makeStore({ dest: "localSettings" });
    const held = store.hold(permEvent("s1", "ls"));
    store.decide("always-allow");
    const body = (await held) as any;
    expect(body.hookSpecificOutput.decision.updatedPermissions[0].destination).toBe("localSettings");
  });

  it("non-derivable tools fall back to one-time allow with NO rule", async () => {
    const store = makeStore();
    const event: AnyHookEvent = {
      session_id: "s1",
      cwd: "C:\\dev\\x",
      hook_event_name: "PermissionRequest",
      tool_name: "SomeMcpTool",
      tool_input: { anything: 1 },
    };
    const held = store.hold(event);
    store.decide("always-allow");
    const body = (await held) as any;
    expect(body.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(body.hookSpecificOutput.decision.updatedPermissions).toBeUndefined();
  });

  it("deriveAlwaysRule covers file tools by exact path", () => {
    expect(
      deriveAlwaysRule({
        id: 1,
        sessionId: "s",
        toolName: "Edit",
        summary: "",
        expiresAt: 0,
        event: { session_id: "s", cwd: "", hook_event_name: "PermissionRequest", tool_input: { file_path: "C:\\x\\y.ts" } },
      }),
    ).toEqual({ toolName: "Edit", ruleContent: "Edit(C:\\x\\y.ts)" });
  });
});

describe("queue depth", () => {
  it("reports how many requests are stacked behind the visible one", () => {
    // Observed live: 10:59:03 held #1, then 10:59:15 held #2 while #1 was
    // still on screen. Answering one instantly promotes the next — same tool,
    // same-looking command — so the panel appears never to have dismissed.
    // The deck has to be able to say "1 of 2" or the press reads as a no-op.
    const store = makeStore();
    expect(store.depth).toBe(0);
    void store.hold(permEvent("s1", "git status"));
    expect(store.depth).toBe(1);
    void store.hold(permEvent("s1", "git diff"));
    expect(store.depth).toBe(2);
    store.decide("allow");
    expect(store.depth).toBe(1);
    expect(store.current?.summary).toBe("git diff");
  });
});

describe("summarizeToolInput", () => {
  it("prefers command, then file_path, then url, then compact JSON", () => {
    expect(summarizeToolInput(permEvent("s", "git push"))).toBe("git push");
    expect(
      summarizeToolInput({ session_id: "s", cwd: "", hook_event_name: "PermissionRequest", tool_input: { url: "https://x.dev" } }),
    ).toBe("https://x.dev");
  });
});
