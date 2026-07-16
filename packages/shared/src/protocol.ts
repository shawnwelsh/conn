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
  state: SessionStatus | "answer" | "command" | "blank";
  badge?: string;
  selected?: boolean;
  /** Render dimmed — used for stale agent slots (no events for a while). */
  dim?: boolean;
}
