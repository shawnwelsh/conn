import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeckConfig {
  port: number;
  decisionTimeoutSeconds: number;
  slots: number;
  doubleTapMs: number;
  longPressMs: number;
  staleSessionMinutes: number;
  /** Where an "always allow" deck press writes its rule. Default "session"
   * (this run only, no disk write). */
  alwaysAllowDestination: "session" | "localSettings" | "projectSettings" | "userSettings";
  delivery: {
    adapter: "ahk" | "sendkeys" | "noop";
    ahkPath: string;
  };
  cannedCommands: Record<string, { label: string; text: string }>;
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

  if (!Number.isInteger(cfg.port) || cfg.port <= 0) throw new Error("config: port must be a positive integer");
  if (cfg.decisionTimeoutSeconds <= 0) throw new Error("config: decisionTimeoutSeconds must be > 0");
  if (cfg.slots < 1 || cfg.slots > 5) throw new Error("config: slots must be 1-5");
  cfg.longPressMs ??= 500;
  cfg.alwaysAllowDestination ??= "session";
  const validDest = ["session", "localSettings", "projectSettings", "userSettings"];
  if (!validDest.includes(cfg.alwaysAllowDestination)) {
    throw new Error(`config: alwaysAllowDestination must be one of ${validDest.join(", ")}`);
  }
  return cfg;
}
