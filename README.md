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
