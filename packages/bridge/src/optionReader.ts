import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "./log.js";

/**
 * Turns a prose ending into real keys.
 *
 * Claude often finishes a turn by offering several courses of action in
 * ordinary sentences — "I can fold it into the existing flow, stand it up
 * separately, or leave it for now". The deck's heuristics can tell that "yes"
 * won't answer that (see needsSpokenAnswer), but they can't enumerate the
 * branches, so the whole row becomes a reading surface and you dictate.
 *
 * This reads the message with a cheap model and returns the options, so the
 * three courses of action become three keys.
 *
 * WHY IT IS GATED: on a subscription the scarce resource is usage limits, not
 * money, and a classifier firing on every turn-end competes with the user's
 * own work. `looksEnumerated` keeps it to messages that plausibly contain
 * choices; everything else stays on the free path.
 *
 * WHY IT MUST BE ISOLATED: this spawns Claude Code, and the user's hooks are
 * user-scope, so the sidecar's own lifecycle events post back to the very
 * bridge that spawned it. `--bare` would avoid that but is not authenticated,
 * and `--settings '{"hooks":{}}'` merges rather than replaces (both verified
 * empirically). So the events DO fire, and the bridge ignores them by cwd
 * instead — see SIDECAR_DIR. Tools are disabled, which also means it can
 * never raise a PermissionRequest and deadlock on its parent's long-poll.
 */

/**
 * Where the sidecar runs. Deliberately OUTSIDE any repo: Claude Code walks up
 * from its cwd collecting CLAUDE.md and project settings, so running it inside
 * a project would feed a classification prompt someone's build instructions
 * and coding standards — bloating it and biasing the answer. Its own empty
 * `.claude/settings.json` keeps project scope quiet too.
 *
 * This does NOT suppress the user's hooks: those are user-scope and merge into
 * every run (verified — `--settings '{"hooks":{}}'` does not clear them, and
 * `--bare`, which would, is unauthenticated). The bridge discards the
 * sidecar's own events by cwd instead.
 */
export const SIDECAR_DIR = join(tmpdir(), "conn-sidecar");

/** Create the sidecar's neutral project dir. Cheap and idempotent. */
export function ensureSidecarDir(): string {
  const claudeDir = join(SIDECAR_DIR, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settings = join(claudeDir, "settings.json");
  if (!existsSync(settings)) writeFileSync(settings, "{}\n");
  return SIDECAR_DIR;
}

/** Is this hook event the sidecar talking about itself? */
export function isSidecarEvent(cwd: string | undefined): boolean {
  if (!cwd) return false;
  return resolve(cwd).toLowerCase().startsWith(resolve(SIDECAR_DIR).toLowerCase());
}

export interface ReadOptions {
  question: string;
  options: string[];
  /**
   * The model's escape hatch: this decision does not compress into key faces
   * and should be read in the window. Better an honest "go look" than four
   * buttons that misrepresent the choice.
   */
  viewInWindow?: boolean;
}

const SCHEMA = {
  type: "object",
  properties: {
    isChoice: {
      type: "boolean",
      description: "True only if the message asks the reader to pick between distinct courses of action.",
    },
    question: { type: "string", description: "The choice being put to the reader, one short line." },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Each course of action as a short imperative label of at most 4 words.",
    },
    viewInWindow: {
      type: "boolean",
      description:
        "True when the choice is real but cannot be honestly compressed into 4-word key labels — the reader needs the full text on screen.",
    },
  },
  required: ["isChoice", "question", "options", "viewInWindow"],
} as const;

const PROMPT = [
  "You are labelling buttons on a physical control deck. Below is the final message",
  "of an assistant's turn. Decide whether it asks the reader to CHOOSE between",
  "distinct courses of action.",
  "",
  "Rules:",
  "- isChoice=false for a yes/no offer, for an open question with no stated",
  "  alternatives, and for a message that merely lists findings or next steps.",
  "- Options must be alternatives the reader picks BETWEEN, not a to-do list.",
  "- Use the message's own words. Never invent an option it does not offer.",
  "- 2 to 4 options. Labels <= 4 words, imperative, distinguishable at a glance.",
  "- If the choice is real but the alternatives carry conditions, trade-offs or",
  "  detail that 4-word labels would misrepresent, set isChoice=true and",
  "  viewInWindow=true and leave options empty. A key that oversimplifies a",
  "  decision is worse than one that says 'read this properly'.",
  "",
  "MESSAGE:",
].join("\n");

/**
 * Cheap pre-filter: does this message plausibly put alternatives to the
 * reader? Deliberately generous — a false positive costs one sidecar call, a
 * false negative costs the feature.
 */
export function looksEnumerated(message: string): boolean {
  const noCode = message.replace(/```[\s\S]*?```/g, " ");
  // Only the tail matters: the offer, if any, closes the message.
  const tail = noCode.slice(-1200).toLowerCase();
  if (!tail.includes("?")) return false;
  if (/\b(either|whichever|option [ab1-9]|route [ab1-9])\b/.test(tail)) return true;
  // "…, or …?" — an alternative put in the closing question.
  if (/,\s*or\b/.test(tail)) return true;
  // An enumerated list near the end: "1) … 2) …" or "(a) … (b) …".
  const enumerated = tail.match(/(?:^|\s)(?:\(?[1-9a-c][).])\s/g);
  return (enumerated?.length ?? 0) >= 2;
}

/**
 * Ask the model to enumerate the choices. Resolves null on ANY failure —
 * timeout, bad JSON, not-a-choice, hallucinated options — because the caller's
 * fallback (a reading surface plus dictation) is always correct, and a wrong
 * button is worse than no button.
 */
export async function readOptions(
  message: string,
  opts: { cwd: string; timeoutMs?: number; model?: string; log: Logger },
): Promise<ReadOptions | null> {
  const raw = await runClaude(
    `${PROMPT}\n${message.slice(-4000)}`,
    opts.cwd,
    opts.model ?? "haiku",
    opts.timeoutMs ?? 20_000,
    opts.log,
  );
  if (!raw) return null;
  let parsed: unknown;
  try {
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    parsed = envelope["structured_output"] ?? JSON.parse(String(envelope["result"] ?? "null"));
  } catch {
    opts.log.warn("optionReader: unparseable reply");
    return null;
  }
  const out = parsed as Partial<ReadOptions> & { isChoice?: boolean };
  if (!out?.isChoice) return null;
  const question = String(out.question ?? "").slice(0, 220);
  // The model judged this too nuanced for key faces. Honour that rather than
  // taking whatever labels it produced anyway.
  if (out.viewInWindow) return { question, options: [], viewInWindow: true };
  if (!Array.isArray(out.options)) return null;
  const options = out.options
    .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    .map((o) => o.trim().slice(0, 40));
  // One option is not a choice, and beyond four there are no keys to put them
  // on — either way the reading surface serves better than a partial list.
  if (options.length < 2 || options.length > 4) return null;
  return { question, options };
}

function runClaude(
  prompt: string,
  cwd: string,
  model: string,
  timeoutMs: number,
  log: Logger,
): Promise<string | null> {
  return new Promise((resolve) => {
    // No shell. `claude` is a real executable, and routing a multi-line
    // message through cmd.exe concatenates rather than escapes its arguments —
    // the prompt arrives mangled and the reply is unparseable.
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(SCHEMA),
        // No tools: this is a text classification, and a tool call would raise
        // a PermissionRequest against the bridge that spawned it.
        "--disallowedTools",
        "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      log.warn({ timeoutMs }, "optionReader: timed out");
      resolve(null);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      log.warn({ err: String(e) }, "optionReader: could not spawn claude");
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) log.warn({ code, err: err.trim().slice(0, 200) }, "optionReader: sidecar failed");
      resolve(code === 0 ? out : null);
    });
    // The message goes in on stdin so nothing has to be escaped.
    child.stdin.end(prompt);
  });
}
