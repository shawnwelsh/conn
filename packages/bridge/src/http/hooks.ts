import type { FastifyInstance } from "fastify";
import type { SessionRegistry } from "../registry.js";
import { nextStatus } from "../status.js";
import { extractSuggestion } from "../suggestions.js";
import { isSidecarEvent } from "../optionReader.js";
import type { AnyHookEvent } from "../hookTypes.js";
import type { Logger } from "../log.js";

/**
 * Hook ingress. Claude Code `http` hooks POST their JSON input here.
 * Everything is logged verbatim; /hooks/event and /hooks/question always
 * answer 200 {} immediately — only /hooks/permission-request may hold its
 * response (Phase 2, via the decisions store).
 */

export interface HookHandlers {
  /** Phase 2: given the raw PermissionRequest payload, returns a promise for
   * the hook response body ({} = defer to the normal dialog). */
  onPermissionRequest?: (event: AnyHookEvent) => Promise<unknown>;
  /** Phase 3: question-layer morph. Must be synchronous-fast. */
  onQuestion?: (event: AnyHookEvent) => void;
  /** Lets the decision store release any pending request of a dead session. */
  onSessionEnd?: (sessionId: string) => void;
  /** Fires after every /hooks/event ingest — used to auto-revert the
   * question layer when its session moves on (answered on screen). */
  onAnyEvent?: (sessionId: string, eventName: string) => void;
  /** A turn ended with a suggestion worth reading for choices. */
  onTurnEnded?: (sessionId: string, lastMessage: string) => void;
}

export function registerHookRoutes(
  app: FastifyInstance,
  registry: SessionRegistry,
  log: Logger,
  handlers: HookHandlers,
): void {
  app.post("/hooks/event", async (req) => {
    const event = req.body as AnyHookEvent;
    log.info({ hook: event.hook_event_name, session: event.session_id, payload: event }, "hook");
    if (isSidecarEvent(event.cwd)) return {}; // our own classifier talking
    applyEvent(registry, event);
    if (event.hook_event_name === "SessionEnd") handlers.onSessionEnd?.(event.session_id);
    handlers.onAnyEvent?.(event.session_id, event.hook_event_name);
    if (event.hook_event_name === "Stop") {
      const last = event["last_assistant_message"];
      if (typeof last === "string" && last) handlers.onTurnEnded?.(event.session_id, last);
    }
    return {};
  });

  app.post("/hooks/question", async (req) => {
    const event = req.body as AnyHookEvent;
    log.info({ hook: "question", session: event.session_id, payload: event }, "hook");
    // Never block: record activity, hand off to the morph handler, return.
    applyEvent(registry, event);
    handlers.onQuestion?.(event);
    return {};
  });

  app.post("/hooks/permission-request", async (req) => {
    const event = req.body as AnyHookEvent;
    log.info({ hook: "PermissionRequest", session: event.session_id, payload: event }, "hook");
    applyEvent(registry, event);
    // NEVER hold the sidecar's own request: it would wait on a deck press for
    // a decision nobody can see, while the bridge waits on the sidecar. Tools
    // are disabled for it, so this should be unreachable — which is exactly
    // why it's worth a guard rather than an assumption.
    if (isSidecarEvent(event.cwd)) return {};
    if (!handlers.onPermissionRequest) return {};
    return handlers.onPermissionRequest(event);
  });
}

function applyEvent(registry: SessionRegistry, event: AnyHookEvent): void {
  if (!event?.session_id) return;
  // The option-reader sidecar is Claude Code too, and the user's hooks are
  // user-scope, so it reports its own lifecycle back to the bridge that
  // spawned it. Discard it by cwd — otherwise the deck grows keys for its own
  // machinery, and a sidecar tool call could deadlock on its parent's
  // permission long-poll.
  if (isSidecarEvent(event.cwd)) return;

  if (event.hook_event_name === "SessionEnd") {
    const existing = registry.get(event.session_id);
    if (existing) registry.recordEvent(existing, "SessionEnd", event["reason"] as string | undefined);
    registry.release(event.session_id);
    return;
  }

  const entry = registry.ensure(event);
  registry.recordEvent(
    entry,
    event.hook_event_name,
    (event.tool_name as string | undefined) ?? (event.notification_type as string | undefined),
  );
  if (event.tool_name) entry.lastTool = String(event.tool_name);

  // Capture live session settings for the stateful mode/effort/model keys.
  if (typeof event.permission_mode === "string") entry.permissionMode = event.permission_mode;
  const effort = event["effort"] as { level?: string } | undefined;
  if (effort?.level) entry.effortLevel = effort.level;
  if (typeof event["model"] === "string") entry.model = event["model"] as string;

  // Suggestion lifecycle: a finished turn may end with a "pre-produced
  // option"; any new activity invalidates it.
  if (event.hook_event_name === "Stop") {
    entry.suggestion = extractSuggestion(event["last_assistant_message"] as string | undefined) ?? undefined;
    entry.suggestionOptions = undefined; // belongs to the turn that just ended
  } else if (["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PermissionRequest"].includes(event.hook_event_name)) {
    entry.suggestion = undefined;
    entry.suggestionOptions = undefined;
    entry.optionsPending = false;
  }

  // Subagent activity keeps the parent session alive/thinking but never
  // drives layer-level states directly (except PermissionRequest, which is a
  // real dialog regardless of origin).
  const status = nextStatus(entry.status, event);
  if (status) registry.setStatus(entry, status);

  // A swept (hidden) session comes back the moment the human types into it.
  // UserPromptSubmit is that signal specifically — an automation's own tool /
  // Stop / Notification traffic must NOT resurface it, or the sweep is
  // pointless. wake() is a no-op unless the session is actually hidden, and it
  // runs AFTER recordEvent so the session lands at the END of the row rather
  // than being MRU-floated to the front. (See registry.wake / sweep.)
  if (event.hook_event_name === "UserPromptSubmit") registry.wake(entry.sessionId);
}
