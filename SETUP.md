# Set up Conn with Claude Code

Conn's one hard prerequisite is **Claude Code itself** — and since you already
have it, it can do the rest of the install for you. Paste the prompt below into
a Claude Code session and it will install the toolchain, configure Conn, merge
the hooks, and prove it works.

## Read this first

This prompt asks Claude Code to install software (via `winget`), edit
`~/.claude/settings.json`, and run the project's scripts. A few deliberate
properties so you can trust it:

- **It leaves Claude Code's normal permission prompts on.** You approve each
  install and each file edit as it goes. It will *not* disable permissions to
  "smooth things out" — that would betray the entire point of this project.
- **It checks before it changes.** Anything already installed or configured is
  detected and skipped, so re-running is safe.
- **It edits your Claude settings through Conn's own installer**, which prints
  the exact diff and writes a backup before merging — not a blind file write.

If any step asks for something you'd rather do yourself, decline it in Claude
Code and do that part by hand (see [`docs/INSTALL.md`](docs/INSTALL.md)).

## The prompt

Copy everything in the box into Claude Code:

```text
Set up "Conn" (a Stream Deck control surface for Claude Code) on this Windows
machine. Work step by step, check before you change anything, and keep asking me
to approve each install and edit — do NOT bypass or disable permission prompts.

1. Preflight. Confirm this is Windows and that `winget` and `git` are available.
   Check whether these are already installed, and only install the missing ones:
   - Node.js >= 24  (winget id: OpenJS.NodeJS.LTS) — verify with `node -v`
   - AutoHotkey v2  (winget id: AutoHotkey.AutoHotkey)
   - Elgato Stream Deck software (winget id: Elgato.StreamDeck) — only if I say
     I have Stream Deck hardware; it's optional (the browser deck needs nothing).

2. Ask me where to put Conn (default C:\dev\conn), then:
   `git clone https://github.com/shawnwelsh/conn <that dir>` and `cd` into it.

3. `npm install` at the repo root.

4. Create config.json from config.example.json. Then help me fill two
   machine-specific values: `delivery.ahkPath` (the full path to AutoHotkey64.exe
   you just installed) and `newSessionDir` (ask me for the repo I mainly work in).

5. Merge the Conn hooks by running `node scripts/install-hooks.mjs`. It prints a
   diff of ~/.claude/settings.json and asks for confirmation — show me the diff
   and let me confirm. Do not edit settings.json any other way.

6. If Stream Deck hardware is in play: `npm run build -w @conn/plugin`, then
   `npx -y @elgato/cli link packages/plugin/com.shawnwelsh.conn.sdPlugin`.

7. Start the bridge with `npm run bridge` and open http://127.0.0.1:3711/ so I
   can see the web deck. Then, to prove it end to end, help me start a separate
   Claude Code session and confirm its key appears on the deck and lights up as
   it works.

8. Summarize what you installed and changed, and remind me that `config.json`
   and the hooks are the only machine-level things you touched.
```

## After it finishes

You're on the browser deck immediately. The full manual steps, a verification
checklist, and how to run the bridge as a background service are in
[`docs/INSTALL.md`](docs/INSTALL.md); every config knob is in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
