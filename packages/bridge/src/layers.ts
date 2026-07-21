import type { TileSpec, Row2Layer } from "@belay/shared";
import type { SessionRegistry, SessionEntry } from "./registry.js";
import type { DeckConfig } from "./config.js";
import { activeSuggestion, isChoiceQuestion } from "./suggestions.js";
import type { CommandEntry } from "./commands.js";

/**
 * Computes the 15 TileSpecs for the whole deck from registry + layer state.
 * Row 1 (0-4): agent slots. Row 2 (5-9): context-morphing. Row 3 (10-14): globals.
 */

export interface PermissionContext {
  sessionId: string;
  toolName: string;
  summary: string;
  /** How many requests are held in total, this one included. Requests stack up
   * faster than a human answers them, and the next one lands on the same keys
   * looking near-identical — without a count, answering reads as a no-op. */
  depth?: number;
  /** Epoch ms at which this falls through to Claude Code's own dialog. */
  expiresAt?: number;
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
  /** Row-3 globals page. Page 2 is currently empty (see HAS_GLOBALS_PAGE2) —
   * the paging stays wired for whenever a global earns a key. */
  row3Page: number;
  /** A console launch (worktree + spawn) is in flight — New shows progress
   * and further presses are ignored. */
  launching?: boolean;
  /** Dictation sidecar state, mirrored from the STT adapter; drives the mic
   * key face. Absent = offline (dictation not configured/available). */
  ptt?: "offline" | "loading" | "ready" | "recording" | "transcribing";
  /** A dictation-into-the-input is live and OURS — so Send currently means
   * "stop, type, submit". False during a rename or deny-reason recording,
   * where Send is still a plain Enter and must not promise otherwise. */
  talkActive?: boolean;
  /** A deny-reason dictation is live for the CURRENT held permission — the
   * "Deny + reason" key renders as a recording indicator with countdown. */
  permissionRec?: { deadline: number };
  /** A rename dictation is live — both the Rename key and the session's OWN
   * row-1 key count down, and either one stops it. */
  renameRec?: { deadline: number; label: string; sessionId: string };
  permission?: PermissionContext;
  question?: QuestionContext;
  controls: DeckControls;
}

/** Keys 2-5 of row 1 while a morph is up: one wide image spelling out what is
 * actually being decided. */
export const MORPH_BANNER_SPAN = 4;

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

/** Globals-row page 2 holds the session-creation verbs that aren't the
 * everyday New: Resume, Fork, Branch. */
export const HAS_GLOBALS_PAGE2 = true;

/** The tile for one command entry, speaking the targeted session's dialect. */
export function commandTile(
  entry: CommandEntry,
  targeted: SessionEntry | undefined,
  controls: DeckControls,
  /** Live rename dictation, so the key can show its own countdown. */
  renameRec?: DeckLayerState["renameRec"],
  flashPhase = false,
): TileSpec {
  if (entry.kind === "builtin" && entry.id === "mode") {
    // Plain ASCII: a ⇥ glyph tofus in the web deck's font.
    if (targeted?.windowKind === "console") return { text: "Mode", subtext: "tab cycle", state: "command" };
    const next = controls.planNext;
    return { text: next === "plan" ? "Plan" : "Auto", subtext: "mode", state: "command" };
  }
  if (entry.kind === "builtin" && entry.id === "model") {
    return targeted?.windowKind === "console"
      ? { text: "Model", subtext: "/model", state: "command" }
      : { text: "Model", subtext: "cycle", state: "command", badge: String(controls.modelNext) };
  }
  if (entry.kind === "builtin" && entry.id === "modemenu") {
    // The full picker chord — desktop dialect only; the console TUI has no
    // such menu (its mode cycling is the "mode" builtin, Tab). Still says its
    // name when unavailable: a numbered but empty key reads as a bug.
    return targeted?.windowKind === "desktop"
      ? { text: "Mode", subtext: "menu", state: "command", icon: "menu" }
      : { text: "Mode", subtext: "desktop only", state: "blank" };
  }
  if (entry.kind === "builtin" && entry.id === "rename") {
    if (renameRec && targeted && renameRec.sessionId === targeted.sessionId) {
      return {
        text: `${Math.max(0, Math.ceil((renameRec.deadline - Date.now()) / 1000))}s`,
        subtext: "name it · tap to stop",
        state: "error",
        selected: flashPhase,
      };
    }
    // Says which rename you're getting: a console session's name propagates to
    // its branch and its conversation, a desktop session's is deck-local.
    return targeted?.windowKind === "console"
      ? { text: "Rename", subtext: "name + branch", state: "command", icon: "mic" }
      : { text: "Rename", subtext: "button only", state: "command", icon: "mic" };
  }
  if (entry.kind === "builtin" && entry.id === "sendname") {
    // Shows what it would send, so the sync is never a guess.
    return targeted?.windowKind === "console"
      ? { text: "Send name", subtext: targeted.labelBase, state: "command" }
      : { text: "Send name", subtext: "console only", state: "blank" };
  }
  if (entry.kind === "keys") {
    return { text: entry.label, subtext: entry.keys.join(" · "), state: "command" };
  }
  if (entry.kind === "text" && entry.dictate) {
    // The mic opens on press — say the argument, then Send.
    return { text: entry.label, subtext: "say it", state: "command", icon: "mic" };
  }
  const t = entry as Extract<CommandEntry, { kind: "text" }>;
  return { text: t.label, subtext: t.label === t.text ? undefined : t.text, state: "command" };
}

/** Mic-key face per sidecar state (absent = offline). It's a toggle, not
 * push-to-talk: tap to start, tap to stop; Send mid-recording stops AND
 * submits. Hence "Talk", not "PTT". */
export function pttTile(ptt: DeckLayerState["ptt"], flashPhase: boolean): TileSpec {
  switch (ptt) {
    case "recording":
      return { text: "REC", subtext: "tap to stop", state: "error", icon: "mic", selected: flashPhase };
    case "transcribing":
      return { text: "Talk", subtext: "transcribing…", state: "waiting", icon: "mic", selected: flashPhase };
    case "ready":
      return { text: "Talk", subtext: "tap to start", state: "command", icon: "mic" };
    case "loading":
      return { text: "Talk", subtext: "loading…", state: "blank", icon: "mic" };
    default:
      return { text: "Talk", subtext: "offline", state: "blank", icon: "mic" };
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
  if (morphSessionId && layer.row1.mode === "agents") {
    // Deciding requires READING. A 144px subtext under a session name cannot
    // hold a real command, so while a morph is up the top row becomes: who is
    // asking (key 1, flashing) + what they're asking (keys 2-5 as one wide
    // banner). Row 2 keeps the answers directly underneath, so the eye reads
    // down and the thumb follows. Row 3 is untouched.
    const asking = registry.get(morphSessionId);
    const queued = layer.row2 === "permission" ? (layer.permission?.depth ?? 1) : 1;
    tiles.push({
      text: asking?.label ?? "session",
      subtext: queued > 1 ? `${queued} pending` : undefined,
      state: asking?.status ?? "waiting",
      badge: asking?.windowKind === "console" ? "›_" : undefined,
      selected: flashPhase,
      dead: asking?.windowDead,
    });
    const detail =
      layer.row2 === "permission" && layer.permission
        ? `${layer.permission.toolName} · ${layer.permission.summary}`
        : (layer.question?.question ?? "");
    for (let i = 0; i < MORPH_BANNER_SPAN; i++) {
      tiles.push({ text: detail, state: "answer", bannerSpan: MORPH_BANNER_SPAN, bannerIndex: i });
    }
  } else if (layer.row1.mode === "pager") {
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
      if (layer.renameRec?.sessionId === session.sessionId) {
        // Listening for this session's new name — the key it was started on
        // becomes the countdown, and stops it when pressed.
        tiles.push({
          text: `${Math.max(0, Math.ceil((layer.renameRec.deadline - now) / 1000))}s`,
          subtext: "name it · tap to stop",
          state: "error",
          selected: flashPhase,
        });
        continue;
      }
      const isMorphOrigin = session.sessionId === morphSessionId;
      const stale = !isMorphOrigin && now - session.lastEventAt > staleMs;
      tiles.push({
        text: session.label,
        // A morph re-lays this whole row (asking session + banner), so the
        // agents branch never renders the origin key while one is up.
        subtext: undefined,
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
    // A plan approval arrives down the same pipe as a tool permission, but it
    // is a different question: approve this plan, or send it back for more
    // thinking. "Always allow" means nothing for a plan. Key POSITIONS are
    // held constant so muscle memory survives the relabelling.
    const isPlan = layer.permission.toolName === "ExitPlanMode";
    const rec = layer.permissionRec;
    const denyLabel = isPlan ? "Keep planning" : "Deny";
    const denyReasonTile: TileSpec = rec
      ? {
          // The countdown IS the key face: a big ticking number (re-rendered
          // by the 2 Hz flash loop), red + flashing = recording.
          text: `${Math.max(0, Math.ceil((rec.deadline - now) / 1000))}s`,
          subtext: "tap to stop",
          state: "error",
          selected: flashPhase,
        }
      : layer.ptt === "transcribing"
        ? { text: denyLabel, subtext: "transcribing…", state: "waiting", icon: "mic", selected: flashPhase }
        : {
            text: denyLabel,
            state: "answer",
            icon: "mic",
            // Honest affordance: without a ready sidecar the key is a canned deny.
            subtext: layer.ptt === "ready" ? (isPlan ? "say why" : "dictate") : "canned",
          };
    const queued = layer.permission.depth ?? 1;
    tiles.push(
      // The count rides on the affirmative key because that's where the thumb
      // goes: press it and the number ticks down, proving the press landed
      // even though the next request lands on the identical face.
      {
        text: isPlan ? "Approve plan" : "Allow",
        state: "answer",
        badge: queued > 1 ? String(queued) : undefined,
      },
      isPlan ? { text: "", state: "blank" } : { text: "Always allow", state: "answer" },
      { text: denyLabel, state: "answer", subtext: isPlan ? "back to plan" : "" },
      denyReasonTile,
      // This key hands the request back to the screen — and so does the
      // timeout, silently. Showing the deadline here makes the automatic
      // version legible instead of the panel just disappearing on you.
      {
        text: "Show on screen",
        state: "answer",
        subtext: layer.permission.expiresAt
          ? `auto ${Math.max(0, Math.ceil((layer.permission.expiresAt - now) / 1000))}s`
          : "release",
      },
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
    if (isChoiceQuestion(s.text)) {
      // Either/or: there's no button that answers it, so spend the whole row
      // on reading it. Any key starts dictation (see the controller).
      for (let i = 0; i < 5; i++) {
        tiles.push({ text: s.text, state: "command", bannerSpan: 5, bannerIndex: i });
      }
    } else {
      tiles.push({ text: "Accept", subtext: `sends "${cfg.suggestionAcceptText}"`, state: "answer" });
      for (let i = 0; i < 4; i++) {
        tiles.push({ text: s.text, state: "command", bannerSpan: 4, bannerIndex: i });
      }
    }
  } else if (layer.row2Cmd.mode === "pager") {
    // Browse the whole lineup, 4/page; tap EXECUTES, long-press moves.
    const pages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
    const page = Math.min(layer.row2Cmd.page, pages - 1);
    for (let i = 0; i < COMMANDS_PER_PAGE; i++) {
      const entry = commands[page * COMMANDS_PER_PAGE + i];
      tiles.push(
        entry
          ? { ...commandTile(entry, targeted, layer.controls, layer.renameRec, flashPhase), badge: String(page * COMMANDS_PER_PAGE + i + 1) }
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
      tiles.push(entry ? commandTile(entry, targeted, layer.controls, layer.renameRec, flashPhase) : { text: "", state: "blank" });
    }
    const hidden = Math.max(0, commands.length - COMMANDS_PER_PAGE);
    tiles.push(
      hidden > 0
        ? { text: "Cmds", subtext: `+${hidden} more`, state: "command", icon: "page" }
        : { text: "", state: "blank" },
    );
  }

  // Row 3 — true globals only. Session-specific keys (Mode picker, Rename)
  // live in the session row, configurable in commands.json like everything
  // else that acts on the targeted session.
  if (HAS_GLOBALS_PAGE2 && layer.row3Page === 1) {
    // The other ways to start a session: pick up an old one, copy this one
    // aside, or split it here.
    tiles.push(
      layer.launching
        ? { text: "Resume", subtext: "spawning…", state: "waiting", icon: "resume", selected: flashPhase }
        : { text: "Resume", subtext: "pick session", state: "command", icon: "resume" },
      { text: "Fork", subtext: "copy aside", state: "command", icon: "fork" },
      { text: "Branch", subtext: "split here", state: "command", icon: "branch" },
      { text: "", state: "blank" },
      { text: "Page", subtext: "back", state: "command", icon: "page" },
    );
  } else {
    tiles.push(
      pttTile(layer.ptt, flashPhase),
      // Mid-dictation Send is a compound: stop, type, submit. Keep the plane
      // (that's how the key is found by shape) but light it up and say so.
      layer.talkActive
        ? { text: "Send", subtext: "stop + send", state: "answer", icon: "send" }
        : { text: "Send", subtext: "enter", state: "command", icon: "send" },
      { text: "Esc", subtext: "interrupt", state: "command", icon: "esc" },
      layer.launching
        ? { text: "New", subtext: "spawning…", state: "waiting", icon: "new", selected: flashPhase }
        : { text: "New", subtext: "worktree", state: "command", icon: "new" },
      HAS_GLOBALS_PAGE2
        ? { text: "Page", subtext: "more", state: "command", icon: "page" }
        : { text: "", state: "blank" },
    );
  }

  return tiles;
}
