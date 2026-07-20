import type { SessionStatus } from "@belay/shared";
import type { AnyHookEvent } from "./hookTypes.js";

/**
 * Event → status state machine.
 * Returns the new status, or null when the event doesn't change status
 * (unknown events, or activity that clears a sticky error).
 *
 * error is sticky until the next sign of activity (UserPromptSubmit /
 * PostToolUse), so a red key survives the Stop that usually follows a failure.
 */
export function nextStatus(current: SessionStatus, event: AnyHookEvent): SessionStatus | null {
  switch (event.hook_event_name) {
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
      return "thinking";
    case "PostToolUse":
      return "thinking";
    case "PostToolUseFailure":
      return "error";
    case "PermissionRequest":
      return "waiting";
    case "Notification":
      switch (event.notification_type) {
        case "permission_prompt":
          return "waiting";
        case "idle_prompt":
          return current === "error" ? null : "done";
        default:
          return null;
      }
    case "Stop":
      return current === "error" ? null : "done";
    default:
      return null;
  }
}
