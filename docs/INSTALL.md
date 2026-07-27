# Install & verify (manual)

The hands-on path, and the checklist to confirm a fresh box is working. Prefer
to have Claude Code do this for you? See [`SETUP.md`](../SETUP.md). Every config
value referenced here is documented in [`CONFIGURATION.md`](CONFIGURATION.md).

## Prerequisites

Windows, plus:

| Tool | Why | winget |
|------|-----|--------|
| **Claude Code CLI ≥ 2.1.211** | the whole point; provides the `http` hooks. Must be the **`claude` command on your PATH** — the desktop app alone is not enough, since Conn spawns sessions by running `claude`. Check with `claude --version`. | (install Claude Code) |
| **Node 24+** | runs the bridge | `winget install OpenJS.NodeJS.LTS` |
| **Git** | worktrees for New sessions | `winget install Git.Git` |
| **Python 3.10+** | voice / dictation (on by default) | `winget install Python.Python.3.12` |
| **AutoHotkey v2** | keystroke delivery (optional — see below) | `winget install AutoHotkey.AutoHotkey` |
| **Stream Deck software** | only if you have the hardware | `winget install Elgato.StreamDeck` |

AutoHotkey is optional: monitoring and permission **decisions** work without it
(they return through the hook response). Only *typing* into windows — New,
dictation, slash commands — needs it.

## Steps

```bash
git clone https://github.com/shawnwelsh/conn && cd conn
npm install
cp config.example.json config.json
```

Edit `config.json` for your machine:

- `delivery.ahkPath` — full path to `AutoHotkey64.exe` (accepts `%VAR%`).
- `newSessionDir` — the repo you mainly work in (where **New** spawns when no
  session is targeted).

Merge the hooks (prints the `~/.claude/settings.json` diff, backs up, merges on
confirm):

```bash
node scripts/install-hooks.mjs        # add --dry-run to preview only
```

Start the bridge and open the web deck:

```bash
npm run bridge                        # → http://127.0.0.1:3711/
```

### Optional: Stream Deck hardware

```bash
npm run build -w @conn/plugin
npx -y @elgato/cli link packages/plugin/com.shawnwelsh.conn.sdPlugin
```

Then load the button layout: double-click **`packages/plugin/Conn.streamDeckProfile`**
(or Stream Deck → Profiles ▾ → Import) — a 3×5 profile with the "Deck Key" on
all 15 keys, no per-key setup. If you moved or renamed the repo folder, the
dev-link breaks and the plugin disappears; re-run the `link` command to fix it.

### Voice / dictation (on by default)

Dictation ships **enabled** (`ptt.enabled: true`). Install the sidecar's Python
deps so the mic key comes up "ready" instead of "offline" (the first recording
then downloads a small model):

```bash
python -m pip install faster-whisper sounddevice
```

Don't want it? Set `ptt.enabled: false` in `config.json` and skip the deps —
nothing else changes.

## Verification checklist

Run through this on a fresh box to confirm everything's wired:

- [ ] **Web deck loads** at `http://127.0.0.1:3711/` — a 3×5 grid renders.
- [ ] **A session claims a key.** Start a Claude Code session anywhere; its key
      appears on row 1 with the repo/branch name.
- [ ] **Status tracks.** The key cycles idle → thinking → done as the session
      works and finishes.
- [ ] **Permission morph.** Have that session run a tool that needs approval
      (e.g. a Bash command in default mode); the deck morphs to Allow / Deny and
      the on-screen prompt waits.
- [ ] **Approve from the deck** — the tool proceeds; the morph clears.
- [ ] **Plan approval.** Ask the session for a plan; approve it from the deck and
      confirm the console proceeds in auto mode.
- [ ] **Focus returns.** While working in session A, answer a question/permission
      from session B; confirm the target snaps back to A.
- [ ] **New spawns a worktree.** Press New; a fresh console opens on a
      `deck/<codename>` branch and its key appears.
- [ ] *(AHK)* **Keystrokes land** — a row-2 command types into the targeted
      session.
- [ ] *(voice)* **Mic key is "ready,"** not "offline."
- [ ] *(hardware)* The **Stream Deck mirrors the web deck** tile-for-tile.

## Run the bridge as a background service

So the deck is always live without a terminal open. Any supervisor works; e.g.
[NSSM](https://nssm.cc/):

```bash
nssm install conn-bridge "C:\Program Files\nodejs\npm.cmd" run bridge
nssm set conn-bridge AppDirectory C:\dev\conn
nssm start conn-bridge
```

Or a Task Scheduler task set to "run at logon." The bridge is stateless across
restarts except for the small files it writes under `log.dir`
(`row1-order.json`, `console-bindings.json`), which it restores automatically.
