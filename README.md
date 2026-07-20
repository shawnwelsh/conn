# Belay

Supervise a room full of Claude Code sessions from a grid of 15 keys. Every
session gets a key showing what it's doing; permission prompts morph the keys
into Allow / Deny answers you hit with one press; you can talk to any session,
spawn new ones in their own git worktrees, and deny a tool call *by saying why*.

**It runs in your browser. No hardware needed.** Point a Stream Deck at it
later if you like it — same bridge, nicer buttons.

> In climbing, the belayer holds the rope while the climber leads: you can
> arrest a fall at any moment, but you never make the moves. At sea, "belay
> that" means stop, cancel. Both are this tool.

## Try it in your browser

```bash
git clone https://github.com/shawnwelsh/belay && cd belay
npm install
cp config.example.json config.json
node scripts/install-hooks.mjs   # prints the diff, merges only on confirm
npm run bridge                   # → http://127.0.0.1:3711/
```

Open that URL. You get the entire deck as a clickable 3×5 grid, speaking the
*same* WebSocket protocol as the hardware plugin — same tiles, same gestures
(click, double-click, triple-click, click-and-hold; the bridge does all
gesture recognition, so the browser is not a degraded mode). Start a Claude
Code session anywhere on the machine and watch its key light up.

Everything works here: status lights, permission approve/deny, the question
layer, voice dictation, worktree spawning. The web deck was the primary
development surface before any hardware existed, and it stays a first-class
client.

Requirements: **Node 24+** and **Windows**, plus Claude Code ≥ 2.1.211.
[AutoHotkey v2](https://www.autohotkey.com/) is needed only for the parts that
type into windows — monitoring and permission decisions work without it, since
those travel back through the hook response rather than the keyboard. For
voice, `python -m pip install faster-whisper sounddevice`.

## Architecture

- **`packages/bridge`** — standalone Node service on localhost that owns all
  state. Claude Code `http` hooks POST here; a session registry maps
  `session_id → key slot/status`; renders 144×144 key tiles and pushes them to
  clients over WebSocket. Hosts the held-response ("long-poll") endpoint for
  permission decisions and the web debug deck.
- **`packages/plugin`** — deliberately thin Elgato plugin
  (`@elgato/streamdeck`): renders whatever the bridge sends, reports key
  presses. No logic.
- **Web deck** — `http://127.0.0.1:3711/`, served by the bridge — a clickable
  3×5 grid speaking the *same* WebSocket protocol as the plugin. Not a
  simulator: it's a peer client, and the two can run side by side.
- **`packages/bridge/src/delivery/`** — the swappable input-delivery module
  (console input-buffer injection and an AutoHotkey v2 daemon today; a tmux
  `send-keys` adapter would touch only this directory).

Because every client is just "render these tiles, report these presses", the
bridge is really a control plane for supervising agents that happens to drive
a Stream Deck. A phone, a tablet, or a foot pedal are all the same 40-line
client.

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

Consoles open as **Windows Terminal** tabs (full copy/paste and proper
rendering), and the bridge binds the console's *process* to the session that
starts there, marking it `windowKind: "console"` with a `›_` badge on its key.

That process binding is what makes console sessions fully targetable.
Keystrokes are written straight into the console's input buffer by pid
(`AttachConsole` + `WriteConsoleInput`), so delivery needs no window and steals
no focus — a command lands in a buried session without anything jumping to the
foreground, and it works identically under Windows Terminal and classic
conhost (`consoleHost: "conhost"` if you'd rather). Special keys ride as their
VT sequences, the way tmux does it. Bindings persist across bridge restarts,
so a restart doesn't orphan your consoles.

The deck also speaks each kind's dialect automatically:

| Key | Console session (TUI) | Desktop tab |
|---|---|---|
| Plan/Mode (row 2) | `Shift+Tab` cycles modes | `Ctrl+Shift+M` + number toggle (blind Plan⇄Auto) |
| Model (row 3) | types `/model` + Enter | `Ctrl+Shift+I` + number cycle |
| Commands | exact session, focus-free (pid) | app front window (visible tab) |

Sessions you start yourself in terminals remain `windowKind: "desktop"`-behaved
unless launched via the deck.

## Key layout

- **Row 1** — agent slots (feature-name labels, status colors, targeting,
  long-press move, Pager at ≥6 sessions).
- **Row 2** — actions for the *targeted* session: the command lineup from
  `commands.json` (up to 15 entries; `"mode"`/`"model"` builtins plus slash
  commands sent as type+Enter). First 4 show; key 10 pages the rest — tap in
  the pager **executes**, long-press starts an insert-before move that
  persists back to the file. Entries are slash-command strings,
  `{label, text}` pairs, or the builtins `mode` / `model` / `modemenu` /
  `rename` / `sendname`. Add `"extraEnter": true` for commands that open a
  confirm and need a second Return —
  `{"label": "Remote", "text": "/remote-control", "extraEnter": true}` turns
  on phone/web control in one press. Or bind a chord sequence with `keys` —
  `{"label": "Accept Next", "keys": ["tab", "enter"]}` accepts Claude Code's
  suggested next prompt and sends it, the same Tab-then-Enter you'd type.
  Sequences are spaced so each keystroke lands after the previous one has
  rendered. Hand-edit `commands.json` any time; it hot-reloads. **Commands
  never fire at a session that's sitting at a prompt** (see below).
  Morph layers (permission / question / suggestion) override this row
  automatically.
- **Row 3** — Mic (tap to dictate) · Send · Esc (interrupt) · New (worktree
  console). Globals only: anything that acts on the *targeted* session lives
  in row 2, where you can order it yourself.

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
"Talk — offline" — press it to retry once you've installed them.

Details: a forgotten recording auto-stops at `ptt.maxSeconds` (60) and types
what it has — it never auto-sends; silence transcribes to nothing (VAD) and
nothing is typed. A live recording keeps ownership of the mic key even if
you flip the globals page mid-take. Configure in `config.json` →
`ptt {enabled, python, model, language, device?, maxSeconds,
reasonMaxSeconds}`.

### Naming a session

New spawns a session under a random codename (`brisk-wombat`) because the
feature rarely has a name yet. Once it does, name it by voice two ways:
**triple-tap its key** on row 1, or tap the **`rename`** command in row 2.
Either counts down while you speak; tap again (or tap the mic) to stop early.

The key tells you which rename you're getting. A **console** session says
"name + branch" — the name propagates to its git branch and its Claude Code
conversation. A **desktop** session says "button only": there's no way to
target its conversation safely, so the rename stays deck-local.

Saying "stream deck push to talk" then aligns everything at once:

| Surface | Result |
|---|---|
| Deck button | `stream deck push to talk` |
| Git branch | `deck/brisk-wombat` → `deck/stream-deck-push-to-talk` |
| Claude Code | `/rename stream deck push to talk` (console sessions) |

So the pull request gets the good name too — the button was never the point.
Branches the deck didn't create (your own feature branch, a non-git folder,
the desktop app) are never rewritten; those get a display-only name that
sticks through refreshes and survives bridge restarts. The `/rename` push
goes to console sessions only, where targeting is exact — sending it at the
desktop app would retitle whichever conversation happened to be visible.

Naming also flows the other way: run **`/rename`** (or `/name`) inside any
session and the deck adopts it within 30s, reading Claude Code's own session
metadata. Precedence is **deck rename → `/rename` → git branch → folder**,
so a triple-tap is always the final word. (`/color` can't be mirrored — it
sets the prompt bar for the session but isn't persisted anywhere readable.)

To re-sync at any time — after a branch rename, or when the two drifted —
put **`"sendname"`** in `commands.json`: the key shows the name it would
send and types `/rename <name>` into the targeted console session.

### Answering a trailing question

When a session finishes on an offer, the deck surfaces it on row 2 — the
question bannered across the keys, so you can read it without switching
windows.

A **yes/no** offer ("Want me to also wire the tests?") gets an **Accept** key:
one press sends `yes`. An **either/or** question ("…as a separate cleanup, or
leave it?") gets no Accept key, because "yes" answers neither branch —
instead the question takes **all five keys** and any of them starts dictation.
Tap, say which one you want, and press **Send** to stop-type-and-submit in a
single motion.

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

## Never type into a prompt

A command fired at a session that's waiting on a question is not a command —
it's a blind answer. The text lands in the picker and the Enter behind it
**accepts whatever was highlighted**. That happened once here: a stray Return
approved an unread plan and started the build.

So before any row-2 command, the deck checks whether that session is at a
prompt and refuses if it is (`Esc` still works — it's how you dismiss one).
The signal is Claude Code's own `status: "waiting"`, read fresh from
`~/.claude/sessions/`, which means it catches prompts the deck never saw —
including ones raised *before the bridge started*, which is exactly how the
incident got through. `"extraEnter"` goes further and only ever fires at a
confirm it can positively see; if none appears, or the state is unknown, it
presses nothing.

## Safety model (permission flow)

The deck never approves anything without a physical press. If no press
arrives within `decisionTimeoutSeconds` (default 30), or the bridge is down,
hung, or has no connected deck clients, Claude Code falls through to its
normal interactive permission dialog — never auto-allow, never auto-deny.
This relies on documented Claude Code `http`-hook semantics: non-2xx,
connection failure, and timeout are all non-blocking errors.

## Configuration notes

- `winget install OpenJS.NodeJS.LTS` / `winget install AutoHotkey.AutoHotkey`
  if you need either.
- `delivery.adapter` is `"ahk"` in the example config — the deck will type
  into windows. Set it to `"noop"` for a look-but-don't-touch run; monitoring
  and permission decisions are unaffected either way.
- `alwaysAllowDestination` controls where the "Always allow" key writes its
  rule: `"session"` (default; this run only, no disk write) or
  `"localSettings"` / `"projectSettings"` / `"userSettings"` to persist like
  Claude Code's own "don't ask again".
- `scripts/install-hooks.mjs` is purely additive and idempotent, never
  clobbers existing hook entries, and takes `--dry-run`.

### Stream Deck plugin (hardware)

1. Install Stream Deck software ≥ 7.1 (bundles the plugin Node runtime; SDK
   dev tooling needs Node 24 locally).
2. `npm run build -w @belay/plugin`
3. `npx -y @elgato/cli link packages/plugin/com.shawnwelsh.belay.sdPlugin`
   (dev-links the plugin into Stream Deck; `streamdeck restart
   com.shawnwelsh.belay` after rebuilds).
4. Create a 3×5 profile and place the single "Deck Key" action on all 15
   keys — each instance derives its role from its position; zero per-key
   configuration.

### Run the bridge at startup

Task Scheduler (no extra tools): create a task triggered "At log on" running
`"C:\Program Files\nodejs\node.exe" C:\dev\claude-deck\node_modules\tsx\dist\cli.mjs C:\dev\claude-deck\packages\bridge\src\index.ts`,
"Run only when user is logged on" (it types into your windows, so it must run
in your interactive session). Alternatively NSSM: `nssm install belay-bridge <same command>` —
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
  Note that `AskUserQuestion` also raises a PermissionRequest; the deck lets
  that one through untouched so the options — not an Allow/Deny morph — reach
  the keys.
- Multi-select questions defer to the screen in v1.
