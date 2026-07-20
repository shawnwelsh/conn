import type { AnyHookEvent } from "./hookTypes.js";
import type { Logger } from "./log.js";

/**
 * Pending PermissionRequest store — the "long-poll" side of the morph flow.
 * Each incoming PermissionRequest hook call parks its HTTP response here
 * until a deck press resolves it or the decision window expires.
 *
 * SAFETY INVARIANTS (do not weaken):
 *  - Nothing in this file resolves a request with allow/deny except
 *    resolve(), which is only ever called from a physical/clicked key press.
 *  - Timeout and "no deck clients" always resolve with {} — Claude Code then
 *    shows its normal interactive dialog.
 */

export type PermissionKeyAction = "allow" | "always-allow" | "deny" | "deny-reason" | "show-on-screen";

/** Where an "always allow" rule is written. `session` = this run only, no
 * disk write (default; a physical key shouldn't silently edit settings
 * files). The others persist and mirror CC's own "don't ask again". */
export type AlwaysAllowDestination =
  | "session"
  | "localSettings"
  | "projectSettings"
  | "userSettings";

export interface PendingPermission {
  id: number;
  sessionId: string;
  toolName: string;
  summary: string;
  event: AnyHookEvent;
}

interface Held {
  pending: PendingPermission;
  resolve: (body: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DecisionStore {
  private queue: Held[] = [];
  private counter = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly log: Logger,
    private readonly hasClients: () => boolean,
    private readonly onQueueChanged: () => void,
    private readonly alwaysAllowDestination: AlwaysAllowDestination = "session",
  ) {}

  /** The permission currently shown on the morph layer (head of queue). */
  get current(): PendingPermission | undefined {
    return this.queue[0]?.pending;
  }

  /** Park a PermissionRequest until decision/timeout. Resolves with the hook
   * response body. */
  hold(event: AnyHookEvent): Promise<unknown> {
    if (!this.hasClients()) {
      // No deck connected — never delay the on-screen dialog.
      this.log.info({ session: event.session_id }, "permission: no deck clients, deferring to dialog");
      return Promise.resolve({});
    }
    return new Promise((resolve) => {
      const pending: PendingPermission = {
        id: ++this.counter,
        sessionId: event.session_id,
        toolName: String(event.tool_name ?? "unknown"),
        summary: summarizeToolInput(event),
        event,
      };
      const held: Held = {
        pending,
        resolve,
        timer: setTimeout(() => this.expire(pending.id), this.timeoutMs),
      };
      this.queue.push(held);
      this.log.info(
        { session: event.session_id, tool: pending.toolName, summary: pending.summary, queued: this.queue.length },
        "permission: held",
      );
      this.onQueueChanged();
    });
  }

  /** Resolve the CURRENT permission from a deck key press. `message` carries
   * a dictated deny reason into the decision body (deny/deny-reason only). */
  decide(action: PermissionKeyAction, opts?: { message?: string }): PendingPermission | undefined {
    const held = this.queue[0];
    if (!held) return undefined;
    const body = buildDecisionBody(action, held.pending, this.alwaysAllowDestination, opts?.message);
    this.settle(held, body, `decided: ${action}`);
    return held.pending;
  }

  /** A session's request became moot (e.g. SessionEnd) — release it to the
   * normal flow. */
  releaseSession(sessionId: string): void {
    for (const held of [...this.queue]) {
      if (held.pending.sessionId === sessionId) this.settle(held, {}, "released (session ended)");
    }
  }

  private expire(id: number): void {
    const held = this.queue.find((h) => h.pending.id === id);
    if (held) this.settle(held, {}, "timeout → normal dialog");
  }

  private settle(held: Held, body: unknown, why: string): void {
    const idx = this.queue.indexOf(held);
    if (idx === -1) return;
    this.queue.splice(idx, 1);
    clearTimeout(held.timer);
    this.log.info({ session: held.pending.sessionId, tool: held.pending.toolName, why, body }, "permission: settled");
    held.resolve(body);
    this.onQueueChanged();
  }
}

/** Human-readable one-liner of what's being approved. */
export function summarizeToolInput(event: AnyHookEvent): string {
  const input = (event.tool_input ?? {}) as Record<string, unknown>;
  const tool = String(event.tool_name ?? "");
  if (typeof input["command"] === "string") return input["command"];
  if (typeof input["file_path"] === "string") return input["file_path"];
  if (typeof input["url"] === "string") return input["url"];
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 117) + "…" : json || tool;
}

/**
 * "Always allow" rule derivation — deliberately conservative:
 *  - Bash → exact command rule (repeat approvals of the same command stop).
 *  - Edit/Write/Read → exact file path.
 *  - anything else → null (falls back to a plain one-time allow).
 * Broad prefix rules are a policy decision the user can make on screen; the
 * deck never widens beyond the exact action it showed.
 */
export function deriveAlwaysRule(pending: PendingPermission): { toolName: string; ruleContent: string } | null {
  const input = (pending.event.tool_input ?? {}) as Record<string, unknown>;
  const tool = pending.toolName;
  if (tool === "Bash" && typeof input["command"] === "string") {
    return { toolName: tool, ruleContent: `Bash(${input["command"]})` };
  }
  if (["Edit", "Write", "Read"].includes(tool) && typeof input["file_path"] === "string") {
    return { toolName: tool, ruleContent: `${tool}(${input["file_path"]})` };
  }
  return null;
}

function buildDecisionBody(
  action: PermissionKeyAction,
  pending: PendingPermission,
  alwaysAllowDestination: AlwaysAllowDestination,
  message?: string,
): unknown {
  switch (action) {
    case "allow":
      return decision({ behavior: "allow" });
    case "always-allow": {
      const rule = deriveAlwaysRule(pending);
      if (!rule) return decision({ behavior: "allow", message: "claude-deck: allowed once (no narrow rule derivable)" });
      // Schema verified against the CC 2.1.211 binary: updatedPermissions is
      // a PermissionUpdate[] discriminated on `type`; the addRules variant is
      // { type, rules: [{toolName, ruleContent}], behavior, destination }.
      // The old flat {toolName,destination,mode,ruleContent} shape was
      // silently dropped ("malformed updatedPermissions ignored").
      return decision({
        behavior: "allow",
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: rule.toolName, ruleContent: rule.ruleContent }],
            behavior: "allow",
            destination: alwaysAllowDestination,
          },
        ],
      });
    }
    case "deny":
      return decision({ behavior: "deny", message: message ?? "Denied from claude-deck" });
    case "deny-reason":
      // The dictated reason reaches Claude as structured feedback through the
      // still-held hook response; no/empty transcription → the canned deny.
      return decision({ behavior: "deny", message: message ?? "Denied from claude-deck" });
    case "show-on-screen":
      return {}; // defer → Claude Code's normal dialog appears
  }
}

function decision(body: Record<string, unknown>): unknown {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } };
}
