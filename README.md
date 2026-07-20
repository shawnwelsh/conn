# claude-deck

A 15-key Elgato Stream Deck (3×5) as a physical control surface for multiple
concurrent Claude Code sessions on Windows: live per-session status lights,
keys that morph into permission/question answer buttons, and one-press
commands.

## Architecture

- **`packages/bridge`** — standalone Node service on localhost that owns all
  state. Claude Code `http` hooks POST here; a session registry maps
  `session_id → key slot/status`; renders 144×144 key tiles and pushes them to
  clients over WebSocket. Hosts the held-response ("long-poll") endpoint for
  permission decisions and the web debug deck.
- **`packages/plugin`** — deliberately thin Elgato plugin
  (`@elgato/streamdeck`): renders whatever the bridge sends, reports key
  presses. No logic.
- **Web debug deck** — `http://127.0.0.1:3711/` — a clickable 3×5 grid
  speaking the *same* WebSocket protocol as the plugin. Primary test surface
  until hardware arrives, permanent debug window after.
- **`packages/bridge/src/delivery/`** — the swappable input-delivery module
  (Windows desktop app now via AutoHotkey v2 daemon; tmux `send-keys` adapter
  later touches only this directory).

## Two functions, logically separated

The deck does two distinct things, and they have different reach because the
Claude desktop app runs every conversation as a tab inside **one** OS window:

1. **Monitor & respond** — per-session, driven entirely by hooks, needs no
   window focus: live status lights, the permission morph
   (Allow / Always-allow / Deny), and the question layer. These auto-target
   the requesting session by `session_id` and work fully regardless of which
   tab is visible. This is the deck's core.
2. **Control the active conversation** — window-level keystrokes (mode, Send,
   Esc, canned commands) that land in whatever conversation is **on screen**.
   With `delivery.windowMode: "activeWindow"` (default) these intentionally go
   to the Claude app's front window; the deck does not try to reach a specific
   background tab, because the desktop app exposes no per-tab window and only
   relative session cycling (`Ctrl+Tab`), not jump-to-index.

Set `delivery.windowMode: "perSession"` when each session is its own OS window
(separate terminals) to target them individually; the planned tmux adapter
supersedes this with true per-pane targeting.

### Console sessions — full per-session control

The **New** key (row 3) spawns `newSessionCommand` (default `claude`) in a
fresh console window. With `newSessionWorktrees: true` (default) it first
creates a **fresh git worktree** in the targeted session's repo — branch
`deck/<codename>`, dir `.claude/worktrees/<codename>` — so parallel sessions
never share a working tree, and **the codename becomes the feature name on
the button** (labels derive from the branch: `deck/nimble-badger` → "nimble
badger"). Non-git dirs or git failures fall back to spawning in place (with a
loud shared-working-tree warning). Worktrees aren't auto-removed; clean up
with `git worktree remove` when a feature is done.

The bridge captures the console's window handle (via `Start-Process` pid →
AHK window lookup — titles are useless because CC overwrites them) and binds
it to the session that starts there, marking it `windowKind: "console"` with
a `›_` badge on its key.

Console sessions are fully targetable: double-tap surfaces *that* window, and
commands go to *that* session even when it's in the background. The deck also
speaks each kind's dialect automatically:

| Key | Console session (TUI) | Desktop tab |
|---|---|---|
| Plan/Mode (row 2) | `Shift+Tab` cycles modes | `Ctrl+Shift+M` + number toggle (blind Plan⇄Auto) |
| Model (row 3) | types `/model` + Enter | `Ctrl+Shift+I` + number cycle |
| Focus / commands | exact window (HWND) | app front window (visible tab) |

Deck-launched consoles use the classic console host (targetability over
aesthetics). Sessions you start yourself in terminals remain
`windowKind: "desktop"`-behaved unless launched via the deck.

## Key layout

- **Row 1** — agent slots (feature-name labels, status colors, targeting,
  long-press move, Pager at ≥6 sessions).
- **Row 2** — actions for the *targeted* session: the command lineup from
  `commands.json` (up to 15 entries; `"mode"`/`"model"` builtins plus slash
  commands sent as type+Enter). First 4 show; key 10 pages the rest — tap in
  the pager **executes**, long-press starts an insert-before move that
  persists back to the file. Hand-edit `commands.json` any time; it
  hot-reloads. Morph layers (permission / question / suggestion) override
  this row automatically.
- **Row 3** — PTT (hold-to-talk) · Send · Esc (interrupt) · New (worktree
  console) · Page. Page flips to a second globals page (Mode picker menu —
  desktop sessions only, room for more).

## Dictation (mic key)

A toggle, not a hold: **tap the mic to start recording, tap again to stop**
— the transcription is typed into the targeted session's input **unsent**
(review it, then press Send). And the shortcut that makes it sing:
**pressing Send while recording stops the dictation, types it, and submits
it** in one motion. Send when nothing is recording is just Enter, as always.
Everything runs locally: a Python sidecar owns the microphone and a
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) model (CPU int8,
`distil-small.en` by default — downloaded once on first start, ~170 MB).

Setup: `python -m pip install faster-whisper sounddevice` (needs Python
3.10+; cp314 wheels exist). No Python or missing deps? The key just shows
"PTT offline" — press it to retry once you've installed them.

Details: a forgotten recording auto-stops at `ptt.maxSeconds` (60) and types
what it has — it never auto-sends; silence transcribes to nothing (VAD) and
nothing is typed. A live recording keeps ownership of the mic key even if
you flip the globals page mid-take. Configure in `config.json` →
`ptt {enabled, python, model, language, device?, maxSeconds,
reasonMaxSeconds}`.

### Deny with a dictated reason

On the permission layer, **Deny + reason** records up to
`ptt.reasonMaxSeconds` (10) — the key becomes a countdown; tap it again to
stop early. The transcription travels **inside the still-held hook
response** as `{behavior: "deny", message: "<your reason>"}`, so Claude
receives it as structured feedback on that exact tool call — no keystrokes
are typed anywhere. Sidecar offline (key shows "canned"), empty
transcription, or a mic failure all degrade to the plain canned deny. The
overall decision timeout keeps running while you speak: if it expires
mid-dictation the request falls through to the on-screen dialog, exactly as
if the deck had stayed silent.

## Safety model (permission flow)

The deck never approves anything without a physical press. If no press
arrives within `decisionTimeoutSeconds` (default 30), or the bridge is down,
hung, or has no connected deck clients, Claude Code falls through to its
normal interactive permission dialog — never auto-allow, never auto-deny.
This relies on documented Claude Code `http`-hook semantics: non-2xx,
connection failure, and timeout are all non-blocking errors.

## Install

1. Prereqs: Node 24+ (`winget install OpenJS.NodeJS.LTS`), AutoHotkey v2
   (`winget install AutoHotkey.AutoHotkey`), Claude Code ≥ 2.1.211.
2. `npm install`
3. `cp config.example.json config.json` and adjust. Ship-safe default is
   `delivery.adapter: "noop"`; switch to `"ahk"` once you're ready for the
   deck to actually type into windows. `alwaysAllowDestination` controls
   where the "Always allow" key writes its rule — `"session"` (default; this
   run only, no disk write) or `"localSettings"` / `"projectSettings"` /
   `"userSettings"` to persist like CC's own "don't ask again".
4. `node scripts/install-hooks.mjs` — prints the diff for
   `~/.claude/settings.json` and merges only on confirm (purely additive,
   idempotent; never clobbers existing hook entries). `--dry-run` to preview.
5. `npm run bridge`, open `http://127.0.0.1:3711/` — the web debug deck.

### Stream Deck plugin (hardware)

1. Install Stream Deck software ≥ 7.1 (bundles the plugin Node runtime; SDK
   dev tooling needs Node 24 locally).
2. `npm run build -w @claude-deck/plugin`
3. `npx -y @elgato/cli link packages/plugin/com.shawnwelsh.claude-deck.sdPlugin`
   (dev-links the plugin into Stream Deck; `streamdeck restart
   com.shawnwelsh.claude-deck` after rebuilds).
4. Create a 3×5 profile and place the single "Deck Key" action on all 15
   keys — each instance derives its role from its position; zero per-key
   configuration.

### Run the bridge at startup

Task Scheduler (no extra tools): create a task triggered "At log on" running
`"C:\Program Files\nodejs\node.exe" C:\dev\claude-deck\node_modules\tsx\dist\cli.mjs C:\dev\claude-deck\packages\bridge\src\index.ts`,
"Run only when user is logged on" (it types into your windows, so it must run
in your interactive session). Alternatively NSSM: `nssm install claude-deck-bridge <same command>` —
but note NSSM services run in session 0 by default, which breaks window
focus/keystrokes; prefer Task Scheduler here.

## Known limitations (v1)

- **On-screen dialog delay:** while the deck holds a permission, Claude
  Code's own dialog waits up to `decisionTimeoutSeconds` (30s default). Use
  the "Show on screen" key to release it instantly. With no deck client
  connected there is no delay at all.
- **Per-session window targeting** on the desktop app is best-effort (title
  substring match); when the specific session window can't be resolved, the
  adapter focuses the app and acts on the visible session, and logs the
  degradation.
- **Question-layer keystrokes** (digit + Enter) assume the AskUserQuestion
  UI accepts numeric selection — verify against your app version before
  trusting it (permission decisions never use keystrokes and are unaffected).
- Multi-select questions defer to the screen in v1.
