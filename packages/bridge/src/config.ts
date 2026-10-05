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
  /** Seconds the row-2 command pager waits (with no Page press) before it
   * reverts to the default lineup view (page one). */
  cmdPagerRevertSeconds: number;
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
  /** Terminal hosting deck-spawned consoles: "wt" (Windows Terminal — full
   * copy/paste + rendering; default) or "conhost" (classic console). Delivery
   * injects into the console input buffer by pid and works with either. */
  consoleHost: "wt" | "conhost";
  /** Repo the New key uses when NO session is targeted (New is a global —
   * it must work on an empty deck). Unset = New needs a target. */
  newSessionDir?: string;
  /** When true (default), New creates a fresh git worktree on branch
   * deck/<codename> — the codename becomes the feature name on the button. */
  newSessionWorktrees: boolean;
  /** Seconds to wait for `git worktree add` (OneDrive-backed repos are SLOW —
   * a too-short timeout strands completed worktrees). */
  worktreeTimeoutSeconds: number;
  /** Text the suggestion-layer Accept key types into the session. */
  suggestionAcceptText: string;
  /** LEGACY restart path, used only when the bridge is NOT supervised: a
   * command run by a detached PowerShell that waits for the port to free and
   * relaunches us. Unreliable in practice — the restarter has to outlive its
   * dying parent, and repeatedly didn't — which is why
   * scripts/run-bridge-hidden.vbs now supervises instead (see `supervised`).
   * Set to "" to hide the Reboot key on an unsupervised install. */
  restartCommand?: string;
  /** True when the bridge was started by the supervising launcher, which sets
   * CONN_SUPERVISED=1. Then Reboot is simply process.exit(0) — the supervisor
   * brings us back — and nothing has to survive our death. Derived from the
   * environment, never read from config.json. */
  supervised?: boolean;
  /**
   * How long the Claude app's conversation SEARCH gets to settle before the
   * deck presses Enter on it (ms).
   *
   * The app is one window with every conversation as a tab, so the deck reaches
   * a specific one via Ctrl+1 -> Ctrl+Shift+K -> type the name -> Enter. This
   * is the pause that must not be too short: Enter arriving early takes
   * whichever row was on screen, which means acting on the WRONG conversation.
   * Exposed because the right value depends on the machine, and finding it
   * should not require a code change. The post-jump render wait derives from
   * it, so one number tunes the whole sequence.
   */
  desktopJumpSettleMs: number;
  /** Milliseconds between typed text and the submitting Enter on DESKTOP
   * sessions — the Electron app renders its input/slash-popup async and an
   * instant Enter is swallowed. Consoles never delay. */
  desktopSubmitDelayMs: number;
  /** Dictation: tap the mic key to record, tap again to stop — the
   * transcription lands in the targeted session's input (not auto-sent;
   * pressing Send mid-recording stops AND submits). Local faster-whisper via
   * a Python sidecar; missing deps just leave the key "offline". */
  ptt: {
    enabled: boolean;
    python: string;
    model: string;
    language: string;
    /** sounddevice input device name/index; omit for the system default. */
    device?: string;
    /** Deny-with-dictated-reason recording window (seconds); a second press
     * of the key stops early. The decision timeout is never extended. */
    reasonMaxSeconds: number;
    /** Session-rename dictation window (seconds); tap the key again to stop. */
    renameMaxSeconds: number;
    /** @deprecated hold-to-talk relic — the mic key is a toggle now. */
    minHoldMs?: number;
    /** Recording auto-stops (and types, never sends) after this long. */
    maxSeconds: number;
  };
  /**
   * Reading a prose ending with a cheap model so its choices become real keys.
   *
   * ON by default — one of the surface's best tricks: a message's offered
   * choices become pressable keys instead of something you type. The cost to
   * know about: it spawns Claude Code, which draws on YOUR subscription usage
   * (or bills your API key). So it's gated — see looksEnumerated — to run only
   * on messages that plausibly offer a choice, never every turn, and
   * `enabled: false` turns it off.
   */
  optionReader: {
    enabled: boolean;
    /** Model alias for the classification: haiku is ample and cheapest. */
    model: string;
    /** Give up after this long and fall back to the reading surface. */
    timeoutSeconds: number;
  };
  log: { level: string; dir: string };
}

/**
 * Can the deck offer a Reboot key at all? Either the supervisor will bring us
 * back after we exit (the reliable path), or there's a legacy restart command
 * to attempt. With neither, exiting would just leave a dead deck — so the key
 * is hidden rather than offered as a trap.
 */
export function canReboot(cfg: Pick<DeckConfig, "supervised" | "restartCommand">): boolean {
  return Boolean(cfg.supervised || cfg.restartCommand);
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
  cfg.cmdPagerRevertSeconds ??= 6;
  cfg.deadSessionSweepHours ??= 3;
  // Plan mode by default: deck-launched consoles start read-only and plan
  // first, and approving the plan FROM THE DECK drops into auto mode — routine
  // Bash/edits run silently, only risky ones re-surface as a permission. Set
  // newSessionCommand to plain "claude" (or any weaker flag) to opt down.
  cfg.newSessionCommand ??= "claude --permission-mode plan";
  cfg.consoleHost ??= "wt";
  if (!["wt", "conhost"].includes(cfg.consoleHost)) {
    throw new Error('config: consoleHost must be "wt" or "conhost"');
  }
  cfg.newSessionWorktrees ??= true;
  cfg.optionReader ??= { enabled: true, model: "haiku", timeoutSeconds: 20 };
  cfg.optionReader.model ||= "haiku";
  cfg.optionReader.timeoutSeconds ||= 20;
  cfg.worktreeTimeoutSeconds ??= 90;
  cfg.suggestionAcceptText ??= "yes";
  cfg.restartCommand ??= "Start-ScheduledTask -TaskName 'Conn Bridge'";
  // Set by scripts/run-bridge-hidden.vbs, which waits on us and relaunches on
  // exit. Environment, not config: whether we're supervised is a fact about how
  // this process was started, and a config file could easily claim otherwise.
  cfg.supervised = process.env.CONN_SUPERVISED === "1";
  cfg.desktopSubmitDelayMs ??= 250;
  cfg.desktopJumpSettleMs ??= 2000;
  cfg.ptt ??= {} as DeckConfig["ptt"];
  cfg.ptt.enabled ??= true;
  cfg.ptt.python ??= "python";
  cfg.ptt.model ??= "distil-small.en";
  cfg.ptt.language ??= "en";
  cfg.ptt.maxSeconds ??= 60;
  cfg.ptt.reasonMaxSeconds ??= 10;
  cfg.ptt.renameMaxSeconds ??= 10;
  cfg.delivery.windowMode ??= "activeWindow";
  cfg.alwaysAllowDestination ??= "session";
  const validDest = ["session", "localSettings", "projectSettings", "userSettings"];
  if (!validDest.includes(cfg.alwaysAllowDestination)) {
    throw new Error(`config: alwaysAllowDestination must be one of ${validDest.join(", ")}`);
  }
  return cfg;
}
