# Configuration reference

Conn reads **`config.json`** at the repo root. Copy the template and edit:

```bash
cp config.example.json config.json
```

If `config.json` is absent, `config.example.json` is used as-is. Point somewhere
else with the `CLAUDE_DECK_CONFIG` environment variable. The bridge **validates
on boot** and refuses to start on an invalid value, so a typo fails fast rather
than misbehaving quietly. Every key below is optional unless noted — omit one
and you get the default shown.

## Core & network

| Key | Default | What it does |
|-----|---------|--------------|
| `port` | `3711` | Port the bridge serves HTTP + WebSocket on. **Must match the port in your installed hooks** (the installer reads `CLAUDE_DECK_PORT`). Positive integer. |
| `decisionTimeoutSeconds` | `30` | How long a permission request is held on the deck before it **falls through to Claude Code's own dialog**. The `PermissionRequest` hook is installed with this + 5s of headroom. Must be > 0. |
| `log.level` | `"info"` | Pino log level: `trace` `debug` `info` `warn` `error`. |
| `log.dir` | `"logs"` | Directory for bridge logs (and runtime state like `row1-order.json`, `console-bindings.json`). Relative to the repo root. |

## Session model (row 1)

| Key | Default | What it does |
|-----|---------|--------------|
| `slots` | `5` | Row-1 session keys — the visible working set. **1–5.** More sessions than this and the extras page behind the Page key. |
| `maxSessions` | `15` | Total sessions the registry tracks. Beyond this the least-recently-used one is dropped. Must be ≥ `slots`. |
| `staleSessionMinutes` | `60` | A session with no events for this long **dims** (still there, just quiet). |
| `deadSessionSweepHours` | `3` | A dead-window session (the skull) is removed from the deck this long after its console closed. |

## Gestures & timing

| Key | Default | What it does |
|-----|---------|--------------|
| `doubleTapMs` | `300` | Window to detect a double-tap (vs two single taps). |
| `longPressMs` | `500` | Hold this long to start a **move** (row 1) or the equivalent long-press action. |
| `moveCancelSeconds` | `5` | A pending move with no drop target auto-cancels after this. |
| `cmdPagerRevertSeconds` | `6` | The row-2 command pager reverts to the default lineup after this idle. |
| `desktopSubmitDelayMs` | `250` | Milliseconds between typed text and the submitting Enter **on desktop-app sessions** — the Electron input renders async and an instant Enter is swallowed. Consoles never delay. |

## Permissions

| Key | Default | What it does |
|-----|---------|--------------|
| `alwaysAllowDestination` | `"session"` | Where the **Always-allow** key writes its rule. `session` = this run only, no disk write (safest default — a physical key shouldn't silently edit settings files). `localSettings` / `projectSettings` / `userSettings` persist it and mirror Claude Code's own "don't ask again". Conn only ever writes the **exact** rule it showed, never a wildcard. |

## Delivery (keystrokes)

| Key | Default | What it does |
|-----|---------|--------------|
| `delivery.adapter` | `"ahk"` | How Conn types into windows. `ahk` = a persistent AutoHotkey v2 daemon (recommended). `sendkeys` = a zero-dependency PowerShell fallback. `noop` = no keystrokes (monitoring + permission decisions still work — they travel back through the hook response, not the keyboard). |
| `delivery.ahkPath` | *(see example)* | Full path to `AutoHotkey64.exe`. Supports `%VAR%` Windows env expansion, e.g. `%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe`. |
| `delivery.windowMode` | `"activeWindow"` | `activeWindow` sends to the Claude app's front window (correct for the tabbed desktop app). `perSession` resolves each session's own window by title (separate-terminal setups). |

## Launching new sessions

| Key | Default | What it does |
|-----|---------|--------------|
| `newSessionCommand` | `"claude --permission-mode plan"` | Command the **New** key runs in a fresh console. The default starts consoles in **plan mode**; approving a plan from the deck drops into auto mode (routine tools run silently). Set to plain `"claude"` to opt down to per-tool prompting. |
| `consoleHost` | `"wt"` | Terminal for new consoles. `wt` = Windows Terminal (full copy/paste + rendering). `conhost` = classic console. Delivery injects by process id and works with either. |
| `newSessionDir` | *(unset)* | Repo the New key uses when **no session is targeted** (New is global — it has to work on an empty deck). Unset means New needs a target first. |
| `newSessionWorktrees` | `true` | When true, New creates a **fresh git worktree** on branch `deck/<codename>` — the codename becomes the feature name on the key. Non-git dirs fall back to spawning in place. |
| `worktreeTimeoutSeconds` | `90` | How long to wait for `git worktree add`. OneDrive-backed repos are slow; too short a timeout strands a completed worktree. |
| `suggestionAcceptText` | `"yes"` | Text the suggestion-layer **Accept** key types into the session. |

## Voice / dictation (`ptt`)

Tap the mic key to record, tap again to stop; the transcript lands in the
targeted session's input (not auto-sent — pressing Send mid-recording stops
**and** submits). Local [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
via a Python sidecar. If the deps are missing the key just reads "offline" and
nothing else breaks.

| Key | Default | What it does |
|-----|---------|--------------|
| `ptt.enabled` | `true` | Master switch for dictation. |
| `ptt.python` | `"python"` | Interpreter used to launch the STT sidecar. |
| `ptt.model` | `"distil-small.en"` | faster-whisper model. |
| `ptt.language` | `"en"` | Transcription language. |
| `ptt.device` | *(system default)* | `sounddevice` input device name or index. Omit for the default mic. |
| `ptt.maxSeconds` | `60` | Recording auto-stops (and types, never sends) after this long. |
| `ptt.reasonMaxSeconds` | `10` | Recording window for **deny-with-a-dictated-reason**. Never extends the decision timeout. |
| `ptt.renameMaxSeconds` | `10` | Recording window for **rename-by-voice**. |

Deps: `python -m pip install faster-whisper sounddevice`.

## Option reader (`optionReader`)

Reads a prose turn-ending with a cheap model so its choices become real keys.

| Key | Default | What it does |
|-----|---------|--------------|
| `optionReader.enabled` | `false` | **Off by default, deliberately** — it spawns Claude Code, which draws on *your* subscription usage (or bills your API key). Turning it on is the owner's call. Even on, it's gated to messages that plausibly offer a choice. |
| `optionReader.model` | `"haiku"` | Model alias for the classification. Haiku is ample and cheapest. |
| `optionReader.timeoutSeconds` | `20` | Give up after this long and fall back to the plain reading surface. |

## Environment variables

| Var | Used by | Effect |
|-----|---------|--------|
| `CLAUDE_DECK_CONFIG` | bridge | Absolute path to a config file, checked before `config.json`. |
| `CLAUDE_DECK_PORT` | installer | Port baked into the hook URLs (default `3711`). Set it here **and** in `config.port` if you change it. |
| `CLAUDE_SETTINGS` | installer | Override the target `settings.json` (default `~/.claude/settings.json`). |

---

## Hooks (`~/.claude/settings.json`)

Conn works by having Claude Code POST lifecycle events to the local bridge. The
installer (`node scripts/install-hooks.mjs`) merges this block — **additively**
(your existing hooks are untouched), **idempotently** (re-running is a no-op),
after printing the full diff and writing a timestamped backup.

| Event | Route | Timeout | Role |
|-------|-------|---------|------|
| `SessionStart` / `SessionEnd` | `/hooks/event` | 3s | Claim / release a session's key. |
| `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop` | `/hooks/event` | 3s | Drive the status light (thinking / done / error). |
| `Notification` (`permission_prompt\|idle_prompt`) | `/hooks/event` | 3s | Attention states. |
| `PreToolUse` (`AskUserQuestion`) | `/hooks/question` | 3s | Render the question-answer layer. Never blocks. |
| `PermissionRequest` (`*`) | `/hooks/permission-request` | 35s | **The morph.** The bridge holds the response until a deck press or the decision timeout, then answers. |

**Fail-open by design:** a non-2xx, a connection failure (bridge down), a
timeout, or zero connected decks all let Claude Code fall through to its normal
interactive dialog. Conn never turns its own failure into an automatic *allow*.
The short 3s timeouts mean a hung bridge can't noticeably stall a session; only
`PermissionRequest` waits longer, because that one is the interactive decision.

To **uninstall**, remove the `http` entries pointing at `127.0.0.1:<port>/hooks/*`
from `~/.claude/settings.json` (or restore one of the `.backup-*` files the
installer left beside it).

---

## Commands (`commands.json`)

Row 2 is a lineup of up to 15 command keys, read from `commands.json` (copy
`commands.example.json`). The file is a JSON array; each entry is either a
**string** or an **object**.

**String entries** are either a builtin id or a slash command typed into the
targeted session:

- `"/diff"`, `"/compact"`, `"/review"`, … — any slash command; typed and entered.
- `"mode"` — blind mode toggle (cycles Plan ⇄ default via the mode keystroke).
- `"model"` — cycles the model (1→2→3→4).
- `"rename"` — rename the session (voice or type).
- `"sendname"` — send the current session name.
- `"modemenu"` — open the mode menu (desktop dialect).

**Object entries** carry extra behavior:

```jsonc
{ "label": "Accept Next", "keys": ["tab", "enter"] }   // send a chord sequence
{ "label": "Subtask", "text": "/subtask ", "dictate": true } // type, then open the mic to finish
{ "label": "Commit", "text": "/save-work" }            // type + Enter
{ "label": "Remote", "text": "/remote-control", "extraEnter": true } // + a second Enter once the prompt shows
```

| Field | Meaning |
|-------|---------|
| `label` | Key caption (required for objects). |
| `text` | Text/slash command to type into the session. |
| `keys` | Array of chords to send in order (e.g. `["tab","enter"]`, `["escape"]`). |
| `dictate` | After typing `text`, open the mic so you finish the command by voice. |
| `extraEnter` | Press Enter again **if** a prompt appears (for commands that pop a confirmation). |

Reorder or relocate keys live from the deck (long-press → move); the new order
persists back to this file.
