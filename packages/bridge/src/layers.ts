import type { TileSpec, Row2Layer } from "@claude-deck/shared";
import type { SessionRegistry, SessionEntry } from "./registry.js";
import type { DeckConfig } from "./config.js";
import { activeSuggestion } from "./suggestions.js";
import type { CommandEntry } from "./commands.js";

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

/** Row-2 command-lineup interaction (only while row2 === "idle"):
 *  - "default": first 4 entries + pager key.
 *  - "pager": browse all entries, 4/page; tap executes, last key pages/closes.
 *  - "move": insert-before drop targets for the entry being relocated. */
export interface Row2CmdState {
  mode: "default" | "pager" | "move";
  page: number;
  /** Entry index being relocated while in "move" mode. */
  moveSource?: number;
}

export interface DeckLayerState {
  row1: Row1State;
  row2: Row2Layer;
  row2Cmd: Row2CmdState;
  /** Row-3 globals page: 0 = PTT/Send/Esc/New, 1 = Mode-menu + future. */
  row3Page: number;
  /** A console launch (worktree + spawn) is in flight — New shows progress
   * and further presses are ignored. */
  launching?: boolean;
  /** Push-to-talk sidecar state, mirrored from the STT adapter; drives the
   * mic key face. Absent = offline (PTT not configured/available). */
  ptt?: "offline" | "loading" | "ready" | "recording" | "transcribing";
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

export function initialRow2Cmd(): Row2CmdState {
  return { mode: "default", page: 0 };
}

/** Visible command keys per row-2 view (key 10 is the pager/control key). */
export const COMMANDS_PER_PAGE = 4;

/** The tile for one command entry, speaking the targeted session's dialect. */
export function commandTile(
  entry: CommandEntry,
  targeted: SessionEntry | undefined,
  controls: DeckControls,
): TileSpec {
  if (entry.kind === "builtin" && entry.id === "mode") {
    if (targeted?.windowKind === "console") return { text: "Mode", subtext: "⇥ cycle", state: "command" };
    const next = controls.planNext;
    return { text: next === "plan" ? "Plan" : "Auto", subtext: "mode", state: "command" };
  }
  if (entry.kind === "builtin" && entry.id === "model") {
    return targeted?.windowKind === "console"
      ? { text: "Model", subtext: "/model", state: "command" }
      : { text: "Model", subtext: "cycle", state: "command", badge: String(controls.modelNext) };
  }
  const t = entry as Extract<CommandEntry, { kind: "text" }>;
  return { text: t.label, subtext: t.label === t.text ? undefined : t.text, state: "command" };
}

/** Mic-key face per PTT sidecar state (absent = offline). */
export function pttTile(ptt: DeckLayerState["ptt"], flashPhase: boolean): TileSpec {
  switch (ptt) {
    case "recording":
      return { text: "REC", subtext: "release → text", state: "error", icon: "mic", selected: flashPhase };
    case "transcribing":
      return { text: "PTT", subtext: "transcribing…", state: "waiting", icon: "mic", selected: flashPhase };
    case "ready":
      return { text: "PTT", subtext: "hold to talk", state: "command", icon: "mic" };
    case "loading":
      return { text: "PTT", subtext: "loading…", state: "blank", icon: "mic" };
    default:
      return { text: "PTT", subtext: "offline", state: "blank", icon: "mic" };
  }
}

/** Options shown per question page: keys 5-8 are options, key 9 is the pager. */
export const QUESTION_OPTIONS_PER_PAGE = 4;

export function computeTiles(
  registry: SessionRegistry,
  layer: DeckLayerState,
  cfg: DeckConfig,
  /** The row-2 command lineup (from commands.json), in order. */
  commands: readonly CommandEntry[] = [],
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
          ? {
              text: e.label,
              subtext: e.windowDead ? "window gone" : e.status,
              state: "answer",
              badge: String(page * perPage + slot + 1),
              dead: e.windowDead,
            }
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
        dead: session.windowDead,
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
  } else if (layer.row2Cmd.mode === "pager") {
    // Browse the whole lineup, 4/page; tap EXECUTES, long-press moves.
    const pages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
    const page = Math.min(layer.row2Cmd.page, pages - 1);
    for (let i = 0; i < COMMANDS_PER_PAGE; i++) {
      const entry = commands[page * COMMANDS_PER_PAGE + i];
      tiles.push(
        entry
          ? { ...commandTile(entry, targeted, layer.controls), badge: String(page * COMMANDS_PER_PAGE + i + 1) }
          : { text: "", state: "blank" },
      );
    }
    tiles.push(
      pages > 1
        ? { text: `Page ${page + 1}/${pages}`, subtext: "next", state: "command" }
        : { text: "Close", subtext: "commands", state: "command" },
    );
  } else if (layer.row2Cmd.mode === "move") {
    // Insert-before drop targets over the first 4 lineup positions.
    const src = layer.row2Cmd.moveSource !== undefined ? commands[layer.row2Cmd.moveSource] : undefined;
    const srcLabel = src ? (src.kind === "builtin" ? src.id : src.label) : "command";
    for (let i = 0; i < COMMANDS_PER_PAGE; i++) {
      const cur = commands[i];
      const curLabel = cur ? (cur.kind === "builtin" ? cur.id : cur.label) : "end";
      tiles.push({ text: curLabel, subtext: "drop here", state: "answer", badge: String(i + 1) });
    }
    tiles.push({ text: "Cancel", subtext: `moving ${srcLabel}`, state: "command" });
  } else {
    // Default: first 4 lineup entries + the command pager key.
    for (let i = 0; i < COMMANDS_PER_PAGE; i++) {
      const entry = commands[i];
      tiles.push(entry ? commandTile(entry, targeted, layer.controls) : { text: "", state: "blank" });
    }
    const hidden = Math.max(0, commands.length - COMMANDS_PER_PAGE);
    tiles.push(
      hidden > 0
        ? { text: "Cmds", subtext: `+${hidden} more`, state: "command", icon: "page" }
        : { text: "", state: "blank" },
    );
  }

  // Row 3 — PTT / interrupt / globals, paged behind the Page key.
  if (layer.row3Page === 1) {
    // Mode (menu) speaks the desktop picker chord (Ctrl+Shift+M); the console
    // TUI has no such menu — hide the key there (console mode cycling is the
    // row-2 "mode" builtin, Shift+Tab).
    tiles.push(
      targeted?.windowKind === "desktop"
        ? { text: "Mode", subtext: "menu", state: "command", icon: "menu" }
        : { text: "", state: "blank" },
      { text: "", state: "blank" },
      { text: "", state: "blank" },
      { text: "", state: "blank" },
      { text: "Page", subtext: "back", state: "command", icon: "page" },
    );
  } else {
    tiles.push(
      pttTile(layer.ptt, flashPhase),
      { text: "Send", subtext: "enter", state: "command", icon: "send" },
      { text: "Esc", subtext: "interrupt", state: "command", icon: "esc" },
      layer.launching
        ? { text: "New", subtext: "spawning…", state: "waiting", icon: "new", selected: flashPhase }
        : { text: "New", subtext: "worktree", state: "command", icon: "new" },
      { text: "Page", subtext: "more", state: "command", icon: "page" },
    );
  }

  return tiles;
}
