import { describe, expect, it } from "vitest";
import { forLog } from "../src/http/hooks.js";
import type { AnyHookEvent } from "../src/hookTypes.js";

const base = { session_id: "s1", cwd: "C:/dev/x", hook_event_name: "PostToolUse" } as unknown as AnyHookEvent;

// Logged verbatim, these payloads grew bridge.log to 251 MB in twelve days —
// and appending to a file that size stalled the event loop badly enough that
// /api/state took 7 seconds and the deck was visibly laggy.
describe("forLog (hook payloads must not grow without bound)", () => {
  it("caps a huge tool_response but keeps the identifying fields", () => {
    const out = forLog({ ...base, tool_name: "WebFetch", tool_response: "x".repeat(236_000) } as AnyHookEvent) as Record<string, unknown>;
    expect(out.session_id).toBe("s1");
    expect(out.hook_event_name).toBe("PostToolUse");
    expect(out.tool_name).toBe("WebFetch"); // what happened is still legible
    expect(String(out.tool_response)).toContain("236000 chars elided");
    expect(String(out.tool_response).length).toBeLessThan(600);
  });

  it("caps object payloads too, not just strings", () => {
    const big = { prompt: "y".repeat(5000) };
    const out = forLog({ ...base, tool_input: big } as AnyHookEvent) as Record<string, unknown>;
    expect(typeof out.tool_input).toBe("string");
    expect(String(out.tool_input)).toContain("chars elided");
  });

  it("leaves small payloads completely untouched — debuggability is the point", () => {
    const small = { command: "git status" };
    const out = forLog({ ...base, tool_input: small } as AnyHookEvent) as Record<string, unknown>;
    expect(out.tool_input).toEqual(small);
  });

  it("does not invent fields that were absent", () => {
    const out = forLog(base) as Record<string, unknown>;
    expect("tool_response" in out).toBe(false);
    expect("last_assistant_message" in out).toBe(false);
  });
});
