# Conn — public launch plan

Working tracker for taking Conn public. Branch: `feature/conn-launch` → one PR
(the first to travel through the review workflow this plan sets up).

## Decisions (locked)

- **Name:** Conn — the officer who has *the conn* commands the ship's movement.
  Puns on **con·soles**, which is also literally what it drives.
- **License:** MIT © Shawn Welsh.
- **Tagline:** *Take the conn.* — one panel, every Claude Code console.
- **Default posture:** consoles launch `claude --permission-mode plan`; approving
  a plan from the deck drops into auto mode.

## Workstreams

| # | Workstream | Status |
|---|-----------|--------|
| 0 | Rename Belay → Conn (code, docs, web deck) | ✅ done |
| 0b | Plugin rename + reinstall + shipped `Conn.streamDeckProfile` | ✅ done |
| 1 | Governance (LICENSE, CONTRIBUTING, SECURITY, CODEOWNERS, templates, CI) | ✅ done |
| 2 | Install (agentic `SETUP.md` prompt + manual fresh-box runbook) | ✅ done |
| 3 | Reference (full config/hooks/commands reference + Troubleshooting/FAQ) | ✅ done |
| 4 | HTML feature showcase (`docs/showcase.html`) | ✅ done |
| 5 | Announcement drafts (Show HN, X thread, r/ClaudeAI, blurbs) → `docs/launch/announcements/` | ✅ done |
| 6 | Branch-protection ruleset (documented; applied by owner) | ⏳ owner action |

## Why 0b is deferred

The OS won't rename the plugin bundle folder while Stream Deck holds it open,
and changing the plugin **UUID** requires removing the old plugin and linking
the new one on the user's machine regardless. So it travels as one atomic step,
run with Stream Deck quit: `git mv` the folder, flip the manifest UUID + Name +
Category, repoint `build.mjs`/`make-plugin-icons.ts`, rebuild `bin/plugin.js`,
commit — then the user links `com.shawnwelsh.conn.sdPlugin` and reopens SD.

## Reserved for the owner (outward / irreversible — Claude will not do these unprompted)

- Rename the GitHub repo `belay` → `conn` (GitHub auto-redirects the old URL).
- Apply the branch-protection ruleset (Settings → Rules).
- Post the announcements.
- Re-link the renamed plugin in Stream Deck (part of 0b).

## Merge-control model (the "only I approve merges" answer)

Public repos already block outside pushes — strangers can only **fork + open a
PR**, which you alone merge. Hardened by: a ruleset requiring a PR + Code-Owner
review + green CI + no force-push, and `CODEOWNERS = * @shawnwelsh`. License and
merge-control are independent levers: MIT governs what people may do with their
copies; the ruleset governs what lands in *this* repo.
