# Show HN draft

> Post after the GitHub repo is renamed to `conn`. HN prefers plain and honest
> over marketing — this is written that way on purpose.

**Title:**

```
Show HN: Conn – a Stream Deck command surface for Claude Code agents
```

**URL:** `https://github.com/shawnwelsh/conn`

**Body (first comment):**

```
I run several Claude Code sessions at once and kept losing track of which one
was waiting on me and where its approval prompt had scrolled off to. Conn puts
each session on its own key of a 15-key grid: the key shows what the session is
doing, and when it asks for a tool permission the keys morph into
Allow / Always-allow / Deny that I hit with one press. The on-screen dialog
just waits until I decide.

How it works: Claude Code has an `http` hook type, so there are no scripts and
no polling — a small local bridge receives the lifecycle events, and for a
permission request it simply withholds its HTTP response until I press a key
(or it times out). If the bridge is down, times out, or no deck is connected,
Claude Code falls through to its normal dialog. It fails open by design; it
never turns its own failure into an automatic "allow".

A few things fell out of using it that I didn't expect to like as much as I do:
approving a plan drops the session into auto mode so routine work stops
prompting; you can deny a tool call by *speaking* the reason (local whisper),
and Claude reads it; and New spawns a session in its own git worktree so
parallel work never shares a tree.

It runs entirely in the browser — the deck is a web page at 127.0.0.1:3711 —
so you don't need the hardware to try it. The Stream Deck is just nicer buttons
for the same bridge. (The name puns on con·soles, which is also what it drives.)

Caveats: it's Windows-only right now (Windows Terminal, AutoHotkey, the desktop
app's window model), it's a solo project, and it's MIT. Feedback welcome,
especially on the permission-safety model.
```
