/**
 * Wire protocol between the bridge and its deck clients (web debug deck,
 * Elgato plugin). Both clients speak exactly this protocol — nothing may be
 * implemented plugin-only.
 */

export const PROTOCOL_VERSION = 1;

export const GRID = { rows: 3, cols: 5 } as const;
export type Slot = number; // 0..14, row-major: row1 = 0-4, row2 = 5-9, row3 = 10-14

export type SessionStatus = "idle" | "thinking" | "waiting" | "done" | "error";

export type Row2Layer = "idle" | "permission" | "question";

/** Bridge → client */
export type ServerMessage =
  | { type: "hello"; protocolVersion: number; grid: typeof GRID }
  | { type: "render"; keys: KeyRender[] };

export interface KeyRender {
  slot: Slot;
  /** data:image/png;base64,… — 144x144. Empty string clears the key. */
  image: string;
}

/** Client → bridge. Clients report raw key down/up only; ALL interpretation
 * (single vs double tap, long-press, layer routing) is bridge-side — the
 * bridge measures the down→up interval to classify the gesture. */
export type ClientMessage =
  | { type: "identify"; client: "webdeck" | "streamdeck" }
  | { type: "down"; slot: Slot; at: number }
  | { type: "up"; slot: Slot; at: number };

export interface TileSpec {
  text: string;
  subtext?: string;
  /** "idleActive" is a render-only lift for the TARGETED idle session — idle's
   * slate is too close to a veiled neighbour to win. Not a session status. */
  state: SessionStatus | "idleActive" | "answer" | "command" | "blank";
  badge?: string;
  selected?: boolean;
  /**
   * Not the targeted session — render behind a veil so the ONE key that
   * keystrokes and dictation will reach stays the bright one. Brightness,
   * staleness and death are deliberately three different channels:
   * veil = not targeted, desaturated = stale, inverted = dead. A border alone
   * couldn't carry targeting; at 144px it lands as 2px on the 72px panel and
   * gets missed, which is how dictation ends up in the wrong session.
   */
  veil?: boolean;
  /** Stale slot (no events for a while) — drained of colour, not darkened, so
   * it can't be confused with "not targeted". */
  dim?: boolean;
  /** Session's bound window is gone (dead console) — inverted, with a skull. */
  dead?: boolean;
  /** Vector icon drawn above the label (row-3 globals etc.). */
  icon?: "mic" | "send" | "esc" | "new" | "page" | "menu" | "resume" | "fork" | "branch" | "trash";
  /** Banner membership: this tile is slice `bannerIndex` of one string
   * rendered across `bannerSpan` adjacent keys (text carries the full
   * string on every slice). */
  bannerSpan?: number;
  bannerIndex?: number;
  /**
   * Draw the session's status as a SHAPE in the top-right, alongside the
   * colour. Colour alone is one channel: harder to read at an angle, and
   * "waiting" yellow vs "done" green sits on the most common colour-vision
   * axis. `idle` deliberately draws nothing — no news, no mark.
   */
  statusMark?: SessionStatus;
  /**
   * Console session (own window, takes keystrokes) — a quiet ›_ in the
   * BOTTOM-LEFT. You learn it once per session and stop consulting it, so it
   * yields the busy corner to the status mark.
   */
  promptMark?: boolean;
}
