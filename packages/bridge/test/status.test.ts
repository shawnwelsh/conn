import { describe, expect, it } from "vitest";
import { endsPendingQuestion, nextStatus } from "../src/status.js";

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

  it("'Claude is waiting for your input' is an attention state, not a finished one", () => {
    // idle_prompt fires when a session is BLOCKED ON THE HUMAN. Classifying it
    // as done painted the key green and skipped trySurface/pagerFlash, so a
    // session sitting on an unanswered question never announced itself.
    expect(
      nextStatus("thinking", { ...base, hook_event_name: "Notification", notification_type: "idle_prompt" }),
    ).toBe("waiting");
    // Stop is still just "turn over" — it must not become an alert.
    expect(nextStatus("thinking", { ...base, hook_event_name: "Stop" })).toBe("done");
  });

  it("unknown events and notification types are inert", () => {
    expect(nextStatus("thinking", { ...base, hook_event_name: "SomethingNew" })).toBeNull();
    expect(
      nextStatus("thinking", { ...base, hook_event_name: "Notification", notification_type: "auth_success" }),
    ).toBeNull();
  });
});

describe("question layer reversion", () => {
  it("does NOT revert on the notification that says the human is still needed", () => {
    // Observed live: PreToolUse(AskUserQuestion) at 11:04:33 then
    // Notification/permission_prompt "Claude needs your permission" at
    // 11:04:39 — the deck tore its own answer panel down 6s after raising it.
    expect(endsPendingQuestion("Notification")).toBe(false);
  });

  it("reverts once the session actually moves on", () => {
    // The AskUserQuestion's own PostToolUse = answered (on screen or on deck).
    expect(endsPendingQuestion("PostToolUse")).toBe(true);
    expect(endsPendingQuestion("UserPromptSubmit")).toBe(true);
    expect(endsPendingQuestion("Stop")).toBe(true);
    expect(endsPendingQuestion("SessionEnd")).toBe(true);
  });
});
