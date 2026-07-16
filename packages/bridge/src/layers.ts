import type { TileSpec, Row2Layer } from "@claude-deck/shared";
import type { SessionRegistry } from "./registry.js";
import type { DeckConfig } from "./config.js";
import { activeSuggestion } from "./suggestions.js";

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

/**
 * Deck-global control positions. Because the tabbed desktop app hides which
 * conversation is visible and its real mode, these keys are BLIND toggles —
 * they alternate their own position and send the corresponding keystroke,
 * rather than reflecting any tracked session state.
 */
export interface DeckControls {
  /** Mode the Plan key will set on its NEXT press (and the label it shows). */
  planNext: "plan" | "auto";
  /** Model number (1-4) the Model key will send on its next press. */
  modelNext: number;
}

/** Row-1 interaction mode:
 *  - "agents": normal slots (+ pager key when active).
 *  - "pager": browsing overflow sessions to pick one into slot #1.
 *  - "move": a long-press is pending; slots show numbered drop targets. */
export interface Row1State {
  mode: "agents" | "pager" | "move";
  pagerPage: number;
  /** Session being relocated while in "move" mode. */
  moveSource?: string;
}

export interface DeckLayerState {
  row1: Row1State;
  row2: Row2Layer;
  permission?: PermissionContext;
  question?: QuestionContext;
  controls: DeckControls;
}

export function initialControls(): DeckControls {
  return { planNext: "plan", modelNext: 1 };
}

export function initialRow1(): Row1State {
  return { mode: "agents", pagerPage: 0 };
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
  const pagerActive = registry.pagerActive();
  const pagerSlot = cfg.slots - 1; // last slot hosts the pager when active

  // Row 1 — depends on the row-1 mode.
  if (layer.row1.mode === "pager") {
    // Browse overflow sessions, `slots-1` per page; last key advances/closes.
    const entries = registry.overflowEntries();
    const perPage = cfg.slots - 1;
    const pages = Math.max(1, Math.ceil(entries.length / perPage));
    const page = Math.min(layer.row1.pagerPage, pages - 1);
    for (let slot = 0; slot < perPage; slot++) {
      const e = entries[page * perPage + slot];
      tiles.push(
        e
          ? { text: e.label, subtext: e.status, state: "answer", badge: String(page * perPage + slot + 1) }
          : { text: "", state: "blank" },
      );
    }
    tiles.push(
      pages > 1
        ? { text: `Page ${page + 1}/${pages}`, subtext: "next", state: "command" }
        : { text: "Close", subtext: "pager", state: "command" },
    );
  } else if (layer.row1.mode === "move") {
    // Numbered drop targets (insert-before); last key cancels.
    const src = layer.row1.moveSource ? registry.get(layer.row1.moveSource) : undefined;
    for (let slot = 0; slot < cfg.slots - 1; slot++) {
      const cur = registry.bySlot(slot);
      tiles.push({ text: cur?.label ?? "empty", subtext: "drop here", state: "answer", badge: String(slot + 1) });
    }
    tiles.push({ text: "Cancel", subtext: src ? `moving ${src.label}` : "move", state: "command" });
  } else {
    // agents mode — normal slots, last slot becomes the Pager when active.
    for (let slot = 0; slot < 5; slot++) {
      if (pagerActive && slot === pagerSlot) {
        tiles.push({
          text: "Pager",
          subtext: `+${registry.overflowEntries().length} more`,
          state: "command",
          selected: registry.pagerFlashing() ? flashPhase : false,
        });
        continue;
      }
      const session = slot < cfg.slots ? registry.bySlot(slot) : undefined;
      if (!session) {
        tiles.push({ text: "", state: "blank" });
        continue;
      }
      const isMorphOrigin = session.sessionId === morphSessionId;
      const stale = !isMorphOrigin && now - session.lastEventAt > staleMs;
      tiles.push({
        text: session.label,
        subtext: isMorphOrigin && layer.row2 === "permission"
          ? `${layer.permission!.toolName}: ${layer.permission!.summary}`
          : undefined,
        state: session.status,
        // Console sessions (own window, fully targetable) get a ›_ badge.
        badge: session.windowKind === "console" ? "›_" : undefined,
        selected: isMorphOrigin ? flashPhase : session.sessionId === targeted?.sessionId,
        dim: stale,
      });
    }
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
  } else if (activeSuggestion(registry, layer)) {
    // Suggestion layer: the targeted console session finished with a
    // "pre-produced option" — Accept on key 6, the text bannered across 7-10.
    const s = activeSuggestion(registry, layer)!;
    tiles.push({ text: "Accept", subtext: `sends "${cfg.suggestionAcceptText}"`, state: "answer" });
    for (let i = 0; i < 4; i++) {
      tiles.push({ text: s.text, state: "command", bannerSpan: 4, bannerIndex: i });
    }
  } else {
    const targetIsConsole = targeted?.windowKind === "console";
    ROW2_IDLE_KEYS.forEach((key, i) => {
      if (i === 0) {
        if (targetIsConsole) {
          // TUI dialect: Shift+Tab cycles modes; no blind toggle needed.
          tiles.push({ text: "Mode", subtext: "⇥ cycle", state: "command" });
        } else {
          // Desktop dialect: blind plan⇄auto toggle, label = next press.
          const next = layer.controls.planNext;
          tiles.push({ text: next === "plan" ? "Plan" : "Auto", subtext: "mode", state: "command" });
        }
      } else {
        tiles.push({ text: key.label, subtext: key.subtext, state: "command" });
      }
    });
  }

  // Row 3 — globals (Model key speaks the targeted session's dialect)
  const modelIsConsole = targeted?.windowKind === "console";
  tiles.push(
    { text: "PTT", subtext: "reserved", state: "blank" },
    { text: "Send", subtext: "enter", state: "command" },
    { text: "Mode", subtext: "menu", state: "command" }, // opens Ctrl+Shift+M (all modes)
    modelIsConsole
      ? { text: "Model", subtext: "/model", state: "command" }
      : { text: "Model", subtext: "cycle", state: "command", badge: String(layer.controls.modelNext) },
    { text: "Page", subtext: "profile", state: "blank" },
  );

  return tiles;
}
