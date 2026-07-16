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

function makeStore(opts: { clients?: boolean; timeoutMs?: number } = {}) {
  return new DecisionStore(opts.timeoutMs ?? 30_000, noopLog, () => opts.clients ?? true, () => {});
}

afterEach(() => vi.useRealTimers());

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
  it("Bash → exact command rule", async () => {
    const store = makeStore();
    const held = store.hold(permEvent("s1", "npm run build"));
    store.decide("always-allow");
    const body = (await held) as any;
    expect(body.hookSpecificOutput.decision.updatedPermissions).toEqual([
      { toolName: "Bash", destination: "allow", mode: "always", ruleContent: "Bash(npm run build)" },
    ]);
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
        event: { session_id: "s", cwd: "", hook_event_name: "PermissionRequest", tool_input: { file_path: "C:\\x\\y.ts" } },
      }),
    ).toEqual({ toolName: "Edit", ruleContent: "Edit(C:\\x\\y.ts)" });
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
