import { describe, expect, it } from "vitest";
import { nextStatus } from "../src/status.js";

const base = { session_id: "s1", cwd: "C:\\dev\\x" };

describe("status state machine", () => {
  it("follows the happy path idle→thinking→waiting→done", () => {
    expect(nextStatus("idle", { ...base, hook_event_name: "UserPromptSubmit" })).toBe("thinking");
    expect(
      nextStatus("thinking", { ...base, hook_event_name: "Notification", notification_type: "permission_prompt" }),
    ).toBe("waiting");
    expect(nextStatus("waiting", { ...base, hook_event_name: "PostToolUse" })).toBe("thinking");
    expect(nextStatus("thinking", { ...base, hook_event_name: "Stop" })).toBe("done");
  });

  it("PermissionRequest forces waiting", () => {
    expect(nextStatus("thinking", { ...base, hook_event_name: "PermissionRequest" })).toBe("waiting");
  });

  it("error is sticky through Stop and idle_prompt but clears on activity", () => {
    expect(nextStatus("thinking", { ...base, hook_event_name: "PostToolUseFailure" })).toBe("error");
    expect(nextStatus("error", { ...base, hook_event_name: "Stop" })).toBeNull();
    expect(
      nextStatus("error", { ...base, hook_event_name: "Notification", notification_type: "idle_prompt" }),
    ).toBeNull();
    expect(nextStatus("error", { ...base, hook_event_name: "UserPromptSubmit" })).toBe("thinking");
    expect(nextStatus("error", { ...base, hook_event_name: "PostToolUse" })).toBe("thinking");
  });

  it("unknown events and notification types are inert", () => {
    expect(nextStatus("thinking", { ...base, hook_event_name: "SomethingNew" })).toBeNull();
    expect(
      nextStatus("thinking", { ...base, hook_event_name: "Notification", notification_type: "auth_success" }),
    ).toBeNull();
  });
});
