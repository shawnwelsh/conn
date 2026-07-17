import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeckConfig {
  port: number;
  decisionTimeoutSeconds: number;
  slots: number;
  /** Max sessions the registry tracks; beyond this the least-recently-used
   * overflow session is dropped. The pager browses these. */
  maxSessions: number;
  doubleTapMs: number;
  longPressMs: number;
  /** Seconds a pending long-press move waits for a target before cancelling. */
  moveCancelSeconds: number;
  staleSessionMinutes: number;
  /** Hours a dead-window (skulled) session lingers before being swept. */
  deadSessionSweepHours: number;
  /** Where an "always allow" deck press writes its rule. Default "session"
   * (this run only, no disk write). */
  alwaysAllowDestination: "session" | "localSettings" | "projectSettings" | "userSettings";
  delivery: {
    adapter: "ahk" | "sendkeys" | "noop";
    ahkPath: string;
    /**
     * How keystroke commands pick their target window:
     *  - "activeWindow" (default): send to the Claude app's front window —
     *    i.e. the visible conversation. Correct for the tabbed desktop app,
     *    where individual conversations aren't separate OS windows.
     *  - "perSession": resolve each session's own window by title (for
     *    separate-terminal setups; the tmux adapter supersedes this later).
     */
    windowMode: "activeWindow" | "perSession";
  };
  /** Row-2 command lineup file (JSON array, up to 15 entries; "mode"/"model"
   * builtins plus slash-command strings). Relative to the repo root. */
  commandsFile: string;
  /** Command the "New" key runs in a fresh console window. */
  newSessionCommand: string;
  /** When true (default), New creates a fresh git worktree on branch
   * deck/<codename> — the codename becomes the feature name on the button. */
  newSessionWorktrees: boolean;
  /** Text the suggestion-layer Accept key types into the session. */
  suggestionAcceptText: string;
  log: { level: string; dir: string };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Expand %VAR% Windows-style env references. */
function expandEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

export function loadConfig(): DeckConfig {
  const explicit = process.env.CLAUDE_DECK_CONFIG;
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(REPO_ROOT, "config.json"),
    join(REPO_ROOT, "config.example.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`No config found. Tried: ${candidates.join(", ")}`);

  const cfg = JSON.parse(readFileSync(path, "utf8")) as DeckConfig;
  cfg.delivery.ahkPath = expandEnv(cfg.delivery.ahkPath);
  cfg.log.dir = resolve(REPO_ROOT, cfg.log.dir); // cwd-independent
  cfg.commandsFile = resolve(REPO_ROOT, cfg.commandsFile ?? "commands.json");

  if (!Number.isInteger(cfg.port) || cfg.port <= 0) throw new Error("config: port must be a positive integer");
  if (cfg.decisionTimeoutSeconds <= 0) throw new Error("config: decisionTimeoutSeconds must be > 0");
  if (cfg.slots < 1 || cfg.slots > 5) throw new Error("config: slots must be 1-5");
  cfg.maxSessions ??= 15;
  if (cfg.maxSessions < cfg.slots) throw new Error("config: maxSessions must be >= slots");
  cfg.longPressMs ??= 500;
  cfg.moveCancelSeconds ??= 5;
  cfg.deadSessionSweepHours ??= 3;
  cfg.newSessionCommand ??= "claude";
  cfg.newSessionWorktrees ??= true;
  cfg.suggestionAcceptText ??= "yes";
  cfg.delivery.windowMode ??= "activeWindow";
  cfg.alwaysAllowDestination ??= "session";
  const validDest = ["session", "localSettings", "projectSettings", "userSettings"];
  if (!validDest.includes(cfg.alwaysAllowDestination)) {
    throw new Error(`config: alwaysAllowDestination must be one of ${validDest.join(", ")}`);
  }
  return cfg;
}
