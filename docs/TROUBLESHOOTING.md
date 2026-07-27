# Troubleshooting & FAQ

Most problems are one of: the bridge isn't running, the hooks aren't installed,
or a session is in a mode that never asks. Start here.

## The deck is blank — no session keys appear

1. **Is the bridge running?** Start it with `npm run bridge` and open
   `http://127.0.0.1:3711/`. If the browser deck is blank too, it's the bridge,
   not the plugin.
2. **Are the hooks installed?** Run `node scripts/install-hooks.mjs --dry-run`.
   If it says entries are missing, run it for real. Hooks live in
   `~/.claude/settings.json`.
3. **Claude Code version.** Conn needs the `http` hook handler and the
   `PermissionRequest` event — Claude Code **≥ 2.1.211**. Check `claude --version`.
4. Start a Claude Code session **after** the bridge and hooks are in place, and
   watch its key claim a slot.

## Permission prompts aren't reaching the deck

This is almost always **working as intended**: a tool that's auto-approved never
generates a permission prompt, so there's nothing for the deck to show.

- If the session is in **auto mode** (the default after you approve a plan) or
  **bypass mode**, routine tools run without asking — and don't fire the
  `PermissionRequest` hook. Only the commands that mode still pauses on reach the
  deck. That's the design: the deck goes quiet for the noise, loud for the risk.
- If it's the **plan** menu you're waiting on: plan approval is answered by
  keystroke into the console, not by the hook — make sure delivery works (below).
- Genuinely stuck? Check the bridge log (`log.dir`) for `permission: held`. No
  line = the hook isn't firing (see "blank deck" above). A line, but no morph =
  no deck client is connected (the bridge short-circuits to Claude Code's dialog
  when zero decks are listening — by design).

## New spawns in the wrong folder (e.g. `C:\Users\you`)

The targeted session's `cwd` couldn't host a new session — usually because it's
the desktop app's home directory or a non-git folder. Set **`newSessionDir`** in
`config.json` to your main repo; New falls back to it whenever the target can't
host one.

## New does nothing — no console opens (or one flashes and vanishes)

Conn's **New** key spawns a session by running `claude` in a fresh terminal, so
the **`claude` CLI has to be on your PATH**. Having the Claude *desktop app*
installed is not enough — that's a separate program. Confirm with:

```bash
claude --version
```

If that's "not recognized," install the Claude Code CLI (or add it to PATH),
then restart the bridge. This is the command `newSessionCommand` runs, so a wrong
value there fails the same way.

## Keystrokes don't land (approvals work, but typing/New/voice don't)

Delivery needs **AutoHotkey v2**. Monitoring and permission *decisions* travel
back through the hook response and work without it — but typing into windows
doesn't.

- Set `delivery.ahkPath` to your `AutoHotkey64.exe` (it accepts `%VAR%`).
- Check the bridge log at startup for `AHK delivery daemon up`. If it fell back
  to noop, the path is wrong or AHK isn't installed.

## The Stream Deck plugin shows nothing

The plugin is a **thin client** — it renders whatever the bridge sends and does
no logic of its own.

1. The **bridge must be running first**; the plugin connects to it over
   WebSocket. Start the bridge, then the plugin repaints.
2. **The plugin vanished from the actions list** (after moving the repo,
   renaming the bundle folder, or a fresh checkout) — a dev-link points at a
   folder *path*, so if that path changes the link dangles and the plugin
   silently disappears. Re-link it:
   `npx -y @elgato/cli link packages/plugin/com.shawnwelsh.conn.sdPlugin`
   then `npx -y @elgato/cli restart com.shawnwelsh.conn`. (Confirm with
   `npx -y @elgato/cli validate packages/plugin/com.shawnwelsh.conn.sdPlugin`.)
3. No hardware? You don't need the plugin at all — the browser deck at
   `http://127.0.0.1:3711/` is a first-class client with the same tiles and
   gestures.

## Voice / the mic key says "offline"

The dictation sidecar's Python deps are missing. Install them and point
`ptt.python` at the right interpreter:

```bash
python -m pip install faster-whisper sounddevice
```

Pick a specific mic with `ptt.device` (a `sounddevice` name or index). Set
`ptt.enabled: false` to hide the key entirely.

## Worktrees are piling up

New creates a git worktree per session under `.claude/worktrees/<codename>`, plus
a banked `_spare`. They aren't auto-removed. Clean finished ones with
`git worktree remove <path>` (or `git worktree prune` for stale registrations).

## Port 3711 is taken

Change it in **both** places: `config.json` → `port`, and re-run the installer
with the new port so the hook URLs match:

```bash
CLAUDE_DECK_PORT=3799 node scripts/install-hooks.mjs
```

## How do I remove Conn's hooks?

Edit `~/.claude/settings.json` and delete the `http` entries whose URL points at
`127.0.0.1:<port>/hooks/*`, or restore one of the `settings.json.backup-*` files
the installer wrote next to it. Nothing else Conn does touches your Claude setup.

## Does it run on macOS / Linux?

Not yet — Conn is Windows-only today (Windows Terminal, AutoHotkey, the desktop
app's window model). The bridge and web deck are portable in principle; delivery
is the Windows-specific part. See `CONTRIBUTING.md` → Scope.

## Do I need a Stream Deck?

No. The browser deck is the original surface and remains fully functional. The
hardware is a nicer set of buttons for the same bridge.
