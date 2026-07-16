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

## Install (WIP — completed as phases land)

1. Prereqs: Node 24+, AutoHotkey v2, Claude Code ≥ 2.1.211.
2. `npm install`
3. `cp config.example.json config.json` and adjust.
4. `node scripts/install-hooks.mjs` — prints the diff for
   `~/.claude/settings.json` and merges only on confirm (purely additive;
   never clobbers existing hook entries).
5. `npm run bridge`, open `http://127.0.0.1:3711/`.

Running as a startup service (NSSM / Task Scheduler): documented in Phase 2.
