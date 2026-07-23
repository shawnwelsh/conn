# X / Twitter thread draft

> Post after the repo rename. Attach the showcase screenshot (or a short screen
> capture of a real approval) to tweet 1 — the deck morphing is the hook.

**1/**
```
I kept losing track of which Claude Code session was waiting on me.

So I built Conn: a Stream Deck where every agent gets a key, and a permission
prompt turns the keys into Allow / Deny you hit with one press.

Take the conn. 🧵
```

**2/**
```
Each session claims a key and shows what it's doing — idle, thinking, waiting,
done — as a colour and a shape you can read across a whole grid.

No more hunting tabs to find the one that stopped.
```

**3/**
```
When a session asks to run a tool, the keys morph into the answer:
Allow / Always-allow / Deny. The on-screen dialog just waits until you press.

And it fails open — bridge down or no deck connected, Claude Code's normal
prompt shows. It never auto-approves on failure.
```

**4/**
```
The parts I didn't expect to love:

• approve a plan → the session drops into auto mode, routine work stops asking
• deny a tool call by *speaking* the reason (local whisper) — Claude reads it
• New spawns each session in its own git worktree
```

**5/**
```
It runs in your browser — the deck is a web page at 127.0.0.1:3711. No hardware
needed to try it; a Stream Deck is just nicer buttons for the same bridge.

(The name puns on con·soles. Which is what it drives.)
```

**6/**
```
Windows + Claude Code, MIT, solo project. Built with the `http` hooks so there
are no scripts and no polling.

Code, docs, and a one-paste installer:
github.com/shawnwelsh/conn
```
