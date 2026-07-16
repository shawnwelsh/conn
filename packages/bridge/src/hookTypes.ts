/**
 * Shapes of Claude Code hook payloads we consume, per
 * https://code.claude.com/docs/en/hooks (verified against CC 2.1.211 via the
 * Phase-0 probe log — see scripts/probe-hooks.mjs).
 * Fields we don't use are omitted; payloads are logged verbatim regardless.
 */

export interface HookEventBase {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: string;
  /** Present only on subagent-originated events. */
  agent_id?: string;
  agent_type?: string;
}

export interface SessionStartEvent extends HookEventBase {
  hook_event_name: "SessionStart";
  source?: string;
  session_title?: string;
}

export interface SessionEndEvent extends HookEventBase {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export interface NotificationEvent extends HookEventBase {
  hook_event_name: "Notification";
  notification_type?: string; // permission_prompt | idle_prompt | ...
  message?: string;
}

export interface ToolEvent extends HookEventBase {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
}

export interface PermissionRequestEvent extends ToolEvent {
  hook_event_name: "PermissionRequest";
}

/** AskUserQuestion tool_input shape (PreToolUse). */
export interface AskUserQuestionInput {
  questions?: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

/** Loose shape for ingest: any event, any extra fields. */
export interface AnyHookEvent extends HookEventBase {
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
  [key: string]: unknown;
}
