# Publishing Conn

The launch content ships on `feature/conn-launch` as one squashed commit. What's
left is **owner-only** — renaming, visibility, protection, and posting are
outward or irreversible or account actions, so they're yours to run. Do them in
order; each has a UI path and a `gh` one-liner.

## 1 · Review & merge the PR

Skim the diff and merge. CI (typecheck + tests) must be green first — that's the
gate the ruleset will enforce from here on.

```bash
gh pr view --web        # review in the browser
gh pr checks            # confirm CI is green
gh pr merge --squash    # or click "Squash and merge"
```

## 2 · Rename the repo  belay → conn

Settings → General → Repository name → `conn` → Rename. GitHub auto-redirects the
old `…/belay` URLs, so nothing that already links in breaks.

```bash
gh repo rename conn -R shawnwelsh/belay
```

## 3 · Make it public

Only if it's currently private. Settings → General → Danger Zone → Change
visibility → **Public**. This is the moment it goes live — read the confirm.

```bash
gh repo edit shawnwelsh/conn --visibility public --accept-visibility-change-consequences
```

## 4 · Fill the About box

The gear on the repo home, or:

```bash
gh repo edit shawnwelsh/conn \
  --description "Take the conn over your Claude Code agents — a Stream Deck (or browser) command surface. Windows · MIT." \
  --add-topic claude-code --add-topic stream-deck --add-topic elgato \
  --add-topic ai-agents --add-topic developer-tools --add-topic windows --add-topic typescript
```

(Longer blurbs + the topic list live in `docs/launch/announcements/blurbs.md`.)

## 5 · Protect `main`  (so only you approve merges)

Settings → Rules → **New branch ruleset** (or Branches → Add rule), target
`main`:

- ✅ Require a pull request before merging
- ✅ Require review from **Code Owners** (`CODEOWNERS` already points at you)
- ✅ Require status checks to pass → add the **build** check (from CI)
- ✅ Block force pushes; restrict deletions

This is what actually stops anyone — including an accidental local push — from
landing on `main` without a reviewed, green PR. It only starts enforcing the
status check once CI has run at least once, which the launch PR does.

## 6 · (Optional) GitHub Pages for the showcase

Settings → Pages → Source: **Deploy from a branch** → `main` / `/docs`. The
showcase then lives at `https://shawnwelsh.github.io/conn/showcase.html` — drop
that URL into the About box's website field.

## 7 · Set the deck screensaver

Local, not GitHub: Stream Deck app → your device (gear) → Screen Saver → pick
`docs/conn-screensaver-480x272.png`.

## 8 · Announce

Only after 1–4, so every link resolves to the public `conn` repo. Drafts:

- `docs/launch/announcements/show-hn.md` — Hacker News (Show HN)
- `docs/launch/announcements/x-thread.md` — X/Twitter (attach a showcase shot to tweet 1)
- `docs/launch/announcements/reddit-claudeai.md` — r/ClaudeAI

## 9 · Smell-test as a first-timer

Click your own repo link fresh and follow the top of the README (or `SETUP.md`)
exactly as a newcomer would. If any step makes you stop and think, fix the doc
before the traffic arrives — that's the highest-leverage thing you can do today.
