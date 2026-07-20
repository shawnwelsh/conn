import { readFileSync, writeFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import type { Logger } from "./log.js";

/**
 * The row-2 command lineup, defined by a user-editable file (commands.json).
 *
 * File format: a JSON array, up to 15 entries, in deck order:
 *   - "mode"  / "model"          → the builtin cycle keys
 *   - "modemenu"                 → open the full mode picker (desktop only)
 *   - "rename"                   → dictate this session's name
 *   - "sendname"                 → push the button's name into the session
 *                                  (`/rename <name>`, console sessions only)
 *   - "/compact"                 → text command, label = the text itself
 *   - { "label": "Commit", "text": "/save-work" } → text command, custom face
 *   - { …, "extraEnter": true }  → follow with a second Enter, for commands
 *                                  that open a confirm (e.g. /remote-control)
 *   - { …, "dictate": true }     → type the text, then open the mic instead
 *                                  of submitting: for commands whose whole
 *                                  point is the argument (/subtask, /btw,
 *                                  /goal). Send ships prefix + speech.
 *   - { "label": "Accept Next", "keys": ["tab", "enter"] } → a chord
 *                                  sequence, spaced so each lands separately
 *                                  (Tab accepts Claude Code's suggested next
 *                                  prompt, Enter sends it)
 *
 * Text commands are delivered as focus → type → Enter to the TARGETED
 * session. The first 4 entries are the visible keys; the rest live behind
 * the row-2 pager. Deck reorders (long-press → insert-before) are written
 * back here, and hand edits hot-reload.
 */

/**
 * Sanity bound, not a UI limit. This was 15 — one per physical key — but the
 * row-2 pager makes the key count irrelevant, so the only job left is to stop
 * a runaway file from producing an endless pager.
 */
export const MAX_COMMANDS = 60;

export type CommandEntry =
  | { kind: "builtin"; id: "mode" | "model" | "modemenu" | "rename" | "sendname" }
  | { kind: "text"; label: string; text: string; extraEnter?: boolean; dictate?: boolean }
  | { kind: "keys"; label: string; keys: string[] };

const BUILTIN_IDS = ["mode", "model", "modemenu", "rename", "sendname"] as const;

/** What the controller needs from a command lineup (CommandStore implements
 * this; tests can pass a plain object). */
export interface CommandSource {
  all(): readonly CommandEntry[];
  move(fromIndex: number, toIndex: number): void;
}

export const DEFAULT_COMMANDS_JSON: unknown[] = [
  "mode",
  "model",
  "/compact",
  "/review",
  { label: "Commit", text: "/save-work" },
  "/status",
  "/context",
  "/usage",
  "rename",
  "sendname",
];

function parseEntry(raw: unknown): CommandEntry | null {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if ((BUILTIN_IDS as readonly string[]).includes(s)) {
      return { kind: "builtin", id: s as (typeof BUILTIN_IDS)[number] };
    }
    return { kind: "text", label: s, text: s };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { label?: unknown; text?: unknown; extraEnter?: unknown; keys?: unknown; dictate?: unknown };
    if (Array.isArray(o.keys)) {
      const keys = o.keys.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim());
      if (keys.length) {
        const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : keys.join(" ");
        return { kind: "keys", label, keys };
      }
    }
    if (typeof o.text === "string" && o.text.trim()) {
      const text = o.text.trim();
      const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : text;
      if (o.dictate === true) return { kind: "text", label, text, dictate: true };
      return o.extraEnter === true ? { kind: "text", label, text, extraEnter: true } : { kind: "text", label, text };
    }
  }
  return null;
}

function serializeEntry(e: CommandEntry): unknown {
  if (e.kind === "builtin") return e.id;
  if (e.kind === "keys") return { label: e.label, keys: e.keys };
  if (e.dictate) return { label: e.label, text: e.text, dictate: true };
  if (e.extraEnter) return { label: e.label, text: e.text, extraEnter: true };
  return e.label === e.text ? e.text : { label: e.label, text: e.text };
}

export class CommandStore implements CommandSource {
  private entries: CommandEntry[] = [];
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while we write the file ourselves so the watcher skips the echo. */
  private writing = false;

  constructor(
    private readonly path: string,
    private readonly log: Logger,
    private readonly onChanged: () => void,
  ) {}

  all(): readonly CommandEntry[] {
    return this.entries;
  }

  load(): void {
    if (!existsSync(this.path)) {
      this.log.info({ path: this.path }, "commands: creating default file");
      writeFileSync(this.path, JSON.stringify(DEFAULT_COMMANDS_JSON, null, 2) + "\n");
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(raw)) throw new Error("commands file must be a JSON array");
      const parsed = raw.map(parseEntry).filter((e): e is CommandEntry => e !== null);
      if (parsed.length > MAX_COMMANDS) {
        this.log.warn({ dropped: parsed.length - MAX_COMMANDS }, `commands: capped at ${MAX_COMMANDS}`);
      }
      this.entries = parsed.slice(0, MAX_COMMANDS);
    } catch (err) {
      this.log.warn({ err: String(err), path: this.path }, "commands: parse failed — keeping previous lineup");
    }
  }

  /** Hand edits show up on the deck without a restart. */
  startWatching(): void {
    try {
      this.watcher = watch(this.path, () => {
        if (this.writing) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.log.info("commands: file changed — reloading");
          this.load();
          this.onChanged();
        }, 250);
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "commands: watch unavailable");
    }
  }

  /** Insert-before move (same semantics as the row-1 session move),
   * persisted back to the file so curation survives restarts. */
  move(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.entries.length) return;
    const [entry] = this.entries.splice(fromIndex, 1);
    const idx = Math.max(0, Math.min(toIndex, this.entries.length));
    this.entries.splice(idx, 0, entry!);
    this.persist();
    this.onChanged();
  }

  private persist(): void {
    this.writing = true;
    try {
      writeFileSync(this.path, JSON.stringify(this.entries.map(serializeEntry), null, 2) + "\n");
    } catch (err) {
      this.log.warn({ err: String(err) }, "commands: persist failed");
    } finally {
      setTimeout(() => (this.writing = false), 500);
    }
  }

  dispose(): void {
    this.watcher?.close();
  }
}
