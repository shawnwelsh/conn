# Security Policy

Conn sits in a sensitive spot: it intercepts Claude Code's **permission
requests** and can inject keystrokes into console windows. A flaw here could
wrongly approve or deny a tool call, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's
private vulnerability reporting: the repository's **Security** tab →
**Report a vulnerability**. That opens a private advisory visible only to the
maintainer.

Include what you'd expect: affected version/commit, a description, and a
repro if you have one. This is a solo-maintained project, so acknowledgement
is best-effort — but genuine reports will get a response.

## Security model (the invariants a fix must not weaken)

Conn is designed to fail safe. These properties are load-bearing:

- **Localhost only.** The bridge binds `127.0.0.1`. It is not meant to be
  exposed to a network, and nothing in it authenticates a remote caller.
- **No silent approvals.** No code path resolves a held permission with
  allow/deny except a **physical key press**. There is no auto-approval logic.
- **Fail open, never fail loud-and-wrong.** Decision timeout, a crashed or
  absent bridge, or zero connected decks all resolve to `{}` — which lets
  Claude Code show its own normal dialog. Conn never turns its own failure
  into an automatic *allow*.
- **Narrow "always allow."** The always-allow key writes only the exact rule
  it displayed (e.g. the specific command or file path), never a broad wildcard.
- **Hooks are additive and visible.** The installer prints the exact
  `settings.json` diff and merges only on confirmation.

If you find a way to make Conn approve something without a key press, resolve a
permission as *allow* on failure, widen an always-allow rule beyond what was
shown, or reach the bridge from off-host — that's the kind of report this
policy is for.

## Scope

In scope: the bridge (HTTP/WS, hook handling, decision store), the delivery
adapters, and the installer. Out of scope: vulnerabilities in Claude Code,
AutoHotkey, the Elgato software, or Node itself — report those upstream.
