import type { SessionRegistry, SessionEntry } from "./registry.js";
import type { DeckLayerState } from "./layers.js";

/**
 * "Pre-produced option" support: when a session finishes a turn, its Stop
 * hook carries last_assistant_message. If that message ends with a concrete
 * offer/question ("Want me to also wire the tests?"), the deck surfaces it —
 * the text bannered across row-2 keys 7-10, Accept on key 6.
 */

const MAX_SUGGESTION_CHARS = 220;

/**
 * Extract the trailing offer from an assistant message: the last
 * question-sentence of the final non-code paragraph. Returns null when the
 * message doesn't end on an actionable question.
 */
export function extractSuggestion(message: string | undefined): string | null {
  if (!message) return null;
  // Drop fenced code blocks; they can contain stray '?' noise.
  const noCode = message.replace(/```[\s\S]*?```/g, " ");
  const paragraphs = noCode.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lastPara = paragraphs.at(-1);
  if (!lastPara) return null;
  // Collapse markdown emphasis/bullets and whitespace for key display.
  const plain = lastPara.replace(/[*_`#>-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plain.endsWith("?")) return null;
  // Take the last sentence (from the previous terminator to the final '?').
  const m = plain.match(/(?:^|[.!?])\s*([^.!?]+\?)\s*$/);
  const suggestion = (m?.[1] ?? plain).trim();
  if (suggestion.length < 8) return null;
  return suggestion.length > MAX_SUGGESTION_CHARS
    ? suggestion.slice(0, MAX_SUGGESTION_CHARS - 1) + "…"
    : suggestion;
}

/**
 * The suggestion currently actionable on the deck: the TARGETED session's,
 * only while it sits done, and only for console sessions — accept types into
 * the session's own window (HWND), which is only safe when targeting is
 * exact. Purely derived state: it appears/disappears with targeting, status,
 * and morph layers without any extra state machine.
 */
export function activeSuggestion(
  registry: SessionRegistry,
  layer: DeckLayerState,
): { session: SessionEntry; text: string } | null {
  if (layer.row2 !== "idle" || layer.row1.mode !== "agents") return null;
  const session = registry.targetedSession;
  if (!session || session.windowKind !== "console") return null;
  if (session.status !== "done" || !session.suggestion) return null;
  return { session, text: session.suggestion };
}
