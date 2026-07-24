import type { SessionRegistry, SessionEntry } from "./registry.js";
import type { DeckLayerState } from "./layers.js";

/**
 * "Pre-produced option" support: when a session finishes a turn, its Stop
 * hook carries last_assistant_message. If that message ends with a concrete
 * offer/question ("Want me to also wire the tests?"), the deck surfaces it —
 * the text bannered across row-2 keys 7-10, Accept on key 6.
 *
 * Questions a canned "yes" can't answer — either/or ("…, or leave it?") and
 * open ones ("which fields do you want?") — take the whole row as a reading
 * surface and you speak the answer instead. See needsSpokenAnswer.
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
 * Would a canned "yes" actually answer this?
 *
 * "Want me to also wire the tests?" — yes. One press sends it.
 * "Run that as a separate cleanup, or leave it?" — no; "yes" picks neither
 * branch. "Which context fields do you want in the line?" — no; "yes" is not
 * a list of fields. Both of those take the whole row as a reading surface and
 * are answered by voice.
 *
 * Two families are unanswerable:
 *  - alternatives: an "or" that isn't "…or not?"
 *  - open (wh-) questions, detected by the LEADING word of the question, not
 *    by the word appearing anywhere. "Want me to check what changed?" is an
 *    offer with a subordinate clause and keeps its Accept key.
 */
const WH_WORDS = /^(which|what|how|who|whom|whose|when|where|why)\b/;
/** Discourse lead-ins that can precede the real interrogative. */
const LEAD_INS = /^(?:so|and|but|ok|okay|now|then|well|also|finally)\b[\s,:—-]*/;

export function needsSpokenAnswer(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.includes("?")) return false;
  if (/\bor\b/.test(t) && !/\bor not\b/.test(t)) return true;
  // Look at the last question sentence: earlier sentences aren't the ask.
  const lastQuestion = t.split(/(?<=[.!?])\s+/).filter((s) => s.includes("?")).at(-1) ?? t;
  let head = lastQuestion.replace(/^[^a-z]+/, "");
  // Strip any number of stacked lead-ins ("so, and now which…").
  for (let i = 0; i < 3 && LEAD_INS.test(head); i++) head = head.replace(LEAD_INS, "");
  return WH_WORDS.test(head);
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
  if (layer.row2Cmd.mode !== "default") return null; // don't stomp pager/move
  const session = registry.targetedSession;
  if (!session || session.windowKind !== "console") return null;
  if (session.status !== "done" || !session.suggestion) return null;
  return { session, text: session.suggestion };
}

/**
 * True when the active suggestion is an either/or (or open) question whose only
 * answer is voice — the state where the mic key should announce itself as the
 * next step, because the bannered question gives no other cue that talking is
 * how you reply. Mirrors the spoken-answer branch in computeTiles: no read-out
 * option keys, not a view-in-window, and the question needs a spoken answer.
 */
export function awaitingSpokenAnswer(registry: SessionRegistry, layer: DeckLayerState): boolean {
  const sug = activeSuggestion(registry, layer);
  if (!sug) return false;
  const read = sug.session.suggestionOptions;
  if (read?.viewInWindow || read?.options.length) return false;
  return needsSpokenAnswer(sug.text);
}
