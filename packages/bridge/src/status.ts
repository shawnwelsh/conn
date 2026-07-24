import type { SessionStatus } from "@conn/shared";
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
        // "Claude is waiting for your input" — the session is BLOCKED ON THE
        // HUMAN, which is the one thing a fleet surface exists to show. This
        // used to map to done (green), and done never calls trySurface or sets
        // pagerFlash, so an off-page session sitting on an unanswered question
        // stayed silent. Stop still means "turn over"; this means "your move".
        case "idle_prompt":
          return current === "error" ? null : "waiting";
        default:
          return null;
      }
    case "Stop":
      return current === "error" ? null : "done";
    default:
      return null;
  }
}

/**
 * Does this event mean the session that asked a question has moved past it?
 *
 * Notification is deliberately excluded. Claude Code emits it ~6s AFTER a
 * prompt appears ("Claude needs your permission", "Claude is waiting for your
 * input") and it means the human is STILL needed. Treating it as movement made
 * the deck tear down its own answer panel seconds after raising it.
 */
export function endsPendingQuestion(eventName: string): boolean {
  return eventName !== "Notification";
}
