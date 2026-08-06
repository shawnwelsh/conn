import type { SessionStatus } from "@conn/shared";

/**
 * One color language for the whole deck. Status colors fill key backgrounds;
 * "answer" keys (morph layers) get an unmistakable inverted treatment so a
 * permission button can never be confused with an idle command.
 */

export interface TileTheme {
  bg: string;
  fg: string;
  border: string;
  subFg: string;
}

const STATUS_THEMES: Record<SessionStatus, TileTheme> = {
  idle: { bg: "#1f2937", fg: "#d1d5db", border: "#4b5563", subFg: "#9ca3af" },
  thinking: { bg: "#1e3a8a", fg: "#ffffff", border: "#3b82f6", subFg: "#bfdbfe" },
  waiting: { bg: "#854d0e", fg: "#ffffff", border: "#eab308", subFg: "#fef08a" },
  done: { bg: "#14532d", fg: "#ffffff", border: "#22c55e", subFg: "#bbf7d0" },
  error: { bg: "#7f1d1d", fg: "#ffffff", border: "#ef4444", subFg: "#fecaca" },
};

const EXTRA_THEMES: Record<string, TileTheme> = {
  // The TARGETED idle session. Plain idle is a dark slate that, sitting next
  // to a veiled thinking neighbour (dark navy), doesn't read as "this is the
  // one I'm driving". Cyan is bright enough to win against the black-washed
  // rest and distinct in hue from thinking's royal blue, so it can't be
  // mistaken for a busy session. Light text, like every other key.
  idleActive: { bg: "#0891b2", fg: "#ecfeff", border: "#67e8f9", subFg: "#a5f3fc" },
  // Morph-layer answer buttons: light background, dark text — inverted from
  // everything else on the deck.
  answer: { bg: "#f8fafc", fg: "#0f172a", border: "#f97316", subFg: "#475569" },
  // Row 2/3 command keys in the idle layer.
  command: { bg: "#111827", fg: "#93c5fd", border: "#374151", subFg: "#6b7280" },
  blank: { bg: "#0a0a0a", fg: "#404040", border: "#1c1c1c", subFg: "#404040" },
};

export function themeFor(state: string): TileTheme {
  return (STATUS_THEMES as Record<string, TileTheme>)[state] ?? EXTRA_THEMES[state] ?? EXTRA_THEMES.blank!;
}

export const SELECTED_BORDER = "#ffffff";

/**
 * How hard a non-targeted session recedes. This was 0.5, which made the
 * targeted key unmistakable but left the rest genuinely hard to read at a
 * glance — measured at ~30 mean luma against the targeted key's ~142.
 *
 * The hierarchy doesn't rest on this alone: a targeted idle key also switches
 * to bright cyan (`idleActive`), so it differs in HUE and not merely in
 * brightness. That's what leaves room to lighten the veil without weakening the
 * one signal that matters — which console your keystrokes and dictation reach.
 */
export const VEIL_ALPHA = 0.35;
/** A veiled key at the bright end of its slow breath (TileSpec.pulse): lighter
 * than the resting veil, still clearly darker than an unveiled key. */
export const VEIL_ALPHA_BREATH = 0.18;
/** The TARGETED key at the bright end of its breath — a light wash, kept below
 * VEIL_ALPHA_BREATH so a breathing target still outranks a breathing
 * neighbour. */
export const TARGET_ALPHA_BREATH = 0.12;

export const TILE_SIZE = 144; // @2x per Elgato SDK guidance for programmatic setImage
export const FONT_FAMILY = "Segoe UI, sans-serif";
