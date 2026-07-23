# r/ClaudeAI post draft

> Post after the repo rename. This community likes "I built this for myself and
> I'm sharing it" — keep it personal, lead with the problem, invite feedback.

**Title:**

```
I built a Stream Deck control surface for running multiple Claude Code sessions (runs in the browser too)
```

**Body:**

```
I usually have three or four Claude Code sessions going and I kept hitting the
same friction: which one is waiting on me, and where did its permission prompt
go? So I built Conn.

Every session gets a key on a 15-key grid showing its status. When a session
asks to run a tool, the keys morph into Allow / Always-allow / Deny — one press
and the console continues. The on-screen dialog just waits for you.

Things that came out of daily use:

- Approve a plan from the deck and the session drops into auto mode, so routine
  edits/commands stop prompting and only risky ones come back to you.
- You can deny a tool call by *saying why* — it records your voice locally
  (faster-whisper), transcribes it, and Claude gets the reason.
- "New" spawns a session in its own git worktree, so parallel work never
  clobbers a shared tree.
- Answering an interruption from another session hands your focus back to what
  you were working in.

The safety model matters to me: nothing is ever auto-approved. If the bridge is
down, times out, or no deck is connected, Claude Code's normal dialog appears.
It's built on Claude Code's `http` hooks, so no polling and no scripts.

Best part for trying it: it runs entirely in your browser (a web page the
bridge serves) — you don't need a Stream Deck at all. If you have one, it's the
same thing with nicer buttons.

Caveats: Windows-only for now, and it's a solo MIT project. Would genuinely
love feedback, especially from anyone juggling a lot of sessions — what would
make this indispensable for you?

github.com/shawnwelsh/conn
```
