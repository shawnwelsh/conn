import type { TileSpec, Row2Layer } from "@claude-deck/shared";
import type { SessionRegistry } from "./registry.js";
import type { DeckConfig } from "./config.js";

/**
 * Computes the 15 TileSpecs for the whole deck from registry + layer state.
 * Row 1 (0-4): agent slots. Row 2 (5-9): context-morphing. Row 3 (10-14): globals.
 */

export interface PermissionContext {
  sessionId: string;
  toolName: string;
  summary: string;
}

export interface QuestionContext {
  sessionId: string;
  question: string;
  options: string[];
  page: number;
}

export interface DeckLayerState {
  row2: Row2Layer;
  permission?: PermissionContext;
  question?: QuestionContext;
}

export const ROW2_IDLE_KEYS = [
  { label: "Plan", subtext: "toggle" },
  { label: "/compact", subtext: "" },
  { label: "/review", subtext: "" },
  { label: "New", subtext: "session" },
  { label: "Esc", subtext: "interrupt" },
] as const;

/** Options shown per question page: keys 5-8 are options, key 9 is the pager. */
export const QUESTION_OPTIONS_PER_PAGE = 4;

export function computeTiles(
  registry: SessionRegistry,
  layer: DeckLayerState,
  cfg: DeckConfig,
  /** Alternates ~2×/sec while a morph layer is active, driving the flash on
   * the requesting session's key. */
  flashPhase = false,
): TileSpec[] {
  const tiles: TileSpec[] = [];
  const targeted = registry.targetedSession;
  const morphSessionId =
    layer.row2 === "permission" ? layer.permission?.sessionId
    : layer.row2 === "question" ? layer.question?.sessionId
    : undefined;
  const staleMs = cfg.staleSessionMinutes * 60_000;
  const now = Date.now();

  // Row 1 — agent slots
  for (let slot = 0; slot < 5; slot++) {
    const session = slot < cfg.slots ? registry.bySlot(slot) : undefined;
    if (!session) {
      tiles.push({ text: "", state: "blank" });
      continue;
    }
    const isMorphOrigin = session.sessionId === morphSessionId;
    // Stale = no events for staleSessionMinutes. A pending morph keeps a key
    // lit regardless.
    const stale = !isMorphOrigin && now - session.lastEventAt > staleMs;
    tiles.push({
      text: session.label,
      // Name gets all 3 lines normally (status is conveyed by color); the
      // tool/command summary only takes the subtext during a permission morph.
      subtext: isMorphOrigin && layer.row2 === "permission"
        ? `${layer.permission!.toolName}: ${layer.permission!.summary}`
        : undefined,
      state: session.status,
      // Flash the requester; steady border for normal targeting.
      selected: isMorphOrigin ? flashPhase : session.sessionId === targeted?.sessionId,
      dim: stale,
    });
  }

  // Row 2 — morphing layer
  if (layer.row2 === "permission" && layer.permission) {
    tiles.push(
      { text: "Allow", state: "answer" },
      { text: "Always allow", state: "answer" },
      { text: "Deny", state: "answer", subtext: "" },
      { text: "Deny + reason", state: "answer", subtext: "stub" },
      { text: "Show on screen", state: "answer", subtext: "release" },
    );
  } else if (layer.row2 === "question" && layer.question) {
    const q = layer.question;
    const start = q.page * QUESTION_OPTIONS_PER_PAGE;
    const pageOptions = q.options.slice(start, start + QUESTION_OPTIONS_PER_PAGE);
    for (let i = 0; i < QUESTION_OPTIONS_PER_PAGE; i++) {
      const opt = pageOptions[i];
      tiles.push(
        opt !== undefined
          ? { text: opt, state: "answer", badge: String(start + i + 1) }
          : { text: "", state: "blank" },
      );
    }
    const pages = Math.ceil(q.options.length / QUESTION_OPTIONS_PER_PAGE);
    tiles.push(
      pages > 1
        ? { text: `Page ${q.page + 1}/${pages}`, state: "command", subtext: "next page" }
        : { text: "Cancel", state: "command", subtext: "to screen" },
    );
  } else {
    for (const key of ROW2_IDLE_KEYS) {
      tiles.push({ text: key.label, subtext: key.subtext, state: "command" });
    }
  }

  // Row 3 — globals
  const canned = cfg.cannedCommands["key13"];
  tiles.push(
    { text: "PTT", subtext: "reserved", state: "blank" },
    { text: "Send", subtext: "enter", state: "command" },
    { text: "Mode", subtext: "shift+tab", state: "command" },
    { text: canned?.label ?? "—", subtext: "canned", state: canned ? "command" : "blank" },
    { text: "Page", subtext: "profile", state: "blank" },
  );

  return tiles;
}
