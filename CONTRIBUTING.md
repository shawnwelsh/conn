# Contributing to Conn

Thanks for looking. Conn is a single-maintainer, deliberately opinionated
project — it does one thing (drive a fleet of Claude Code consoles from a
15-key surface on Windows) and tries to do it well. Contributions are welcome
inside that lane; this doc is about keeping them easy to accept.

## How changes get in

Conn lives on `main`, protected by a ruleset: outside contributors **fork and
open a pull request**, which is reviewed by the code owner (`@shawnwelsh`) and
merged only with green CI. Nobody pushes to `main` directly. Your fork is
yours to take anywhere the MIT license allows; this repo stays curated.

- **Small fixes** (bugs, docs, a rough edge) — send a PR directly.
- **Anything larger** (a new feature, a behavior change, a new dependency) —
  **open an issue first** so we can agree it fits before you build it. A great
  PR that's out of scope is still a "no," and that's a lousy outcome for your
  time. Checking first is a kindness to both of us.

## Scope

In scope: the Windows + Claude Code control surface — the bridge, the web
deck, the Elgato plugin, delivery, and the docs. Currently **out** of scope
(not "never," just not now): other operating systems, non–Claude Code agents,
and cloud/hosted modes. If you want one of those, an issue to discuss the
shape is the place to start.

## Dev setup

Requires **Node 24+**. No Stream Deck hardware needed — the browser deck is a
first-class client.

```bash
npm install
npm test                              # all workspace tests (vitest)
npx tsc --noEmit -p packages/bridge   # typecheck
npm run bridge                        # → http://127.0.0.1:3711/  (the web deck)
```

## Before you open a PR

- **Tests and typecheck pass locally** — CI runs both and gates the merge.
- **Keep the diff focused** — one concern per PR; unrelated cleanups muddy review.
- **Match the surrounding code** — comment density, naming, and idiom. Conn's
  code explains *why*, not *what*; new code should read like its neighbours.
- **Add a test** for any behavior change. Most of Conn's logic is pure and
  unit-tested; follow the nearest existing test file.

## The permission path is safety-critical

`decisions.ts`, the hook routes, and the delivery adapters sit between Claude
Code and a real tool call. They hold invariants that must not weaken (see
[`SECURITY.md`](SECURITY.md)): nothing resolves a permission without a physical
key press; timeout / bridge-down / no-clients all **fail open** to Claude
Code's own dialog; "always allow" writes only the exact rule it showed. Changes
here get the closest read — flag them clearly in your PR description.

## Commits

Present-tense summary line that says what changed and why it's better
("Return focus after answering an interrupt", not "fix bug"). PRs are
squash-merged, so the PR title becomes the commit — make it a good one.
