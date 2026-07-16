import type { FastifyInstance } from "fastify";
import type { SessionRegistry } from "../registry.js";
import { nextStatus } from "../status.js";
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
    applyEvent(registry, event);
    if (event.hook_event_name === "SessionEnd") handlers.onSessionEnd?.(event.session_id);
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
    if (!handlers.onPermissionRequest) return {};
    return handlers.onPermissionRequest(event);
  });
}

function applyEvent(registry: SessionRegistry, event: AnyHookEvent): void {
  if (!event?.session_id) return;

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

  // Subagent activity keeps the parent session alive/thinking but never
  // drives layer-level states directly (except PermissionRequest, which is a
  // real dialog regardless of origin).
  const status = nextStatus(entry.status, event);
  if (status) registry.setStatus(entry, status);
}
