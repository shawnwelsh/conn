# Phase 4 design stub — push-to-talk & deny-with-dictated-reason

Design only; no implementation yet. Key 10 (row 3, first key) is reserved.

## Push-to-talk (PTT)

**Goal:** hold the PTT key, speak, release; the transcription lands in the
targeted session's input box (not auto-sent — Send is its own key).

**Pipeline**

1. Deck reports `keyDown`/`keyUp` for slot 10 (protocol addition: press
   messages gain a `phase: "down" | "up"` field; web deck maps
   mousedown/mouseup; the current `press` stays the `down` default so other
   keys are unaffected).
2. Bridge records mic audio between down/up: spawn a persistent local STT
   sidecar (Python, `faster-whisper`, `small.en` or `distil-small.en` model,
   CPU int8 — no GPU dependency) that owns the microphone via `sounddevice`.
   Bridge ⇄ sidecar over stdin/stdout JSON lines: `{"cmd":"start"}`,
   `{"cmd":"stop"}` → `{"text":"…"}`.
3. Bridge delivers the text via `DeliveryAdapter.sendText(targeted, text)` —
   same adapter, so it works identically after the tmux migration.

**Latency budget:** distil-small.en on CPU transcribes ~5s of speech well
under a second; acceptable for command dictation.

**Failure posture:** sidecar down → PTT key renders disabled (gray, "PTT
offline"); never queues audio silently.

**Config:** `ptt: { model, device, language, sidecarPort? }` in config.json.

## Deny-with-dictated-reason

Reuses the same sidecar. On the permission layer, "Deny + reason":

1. Key press starts a 10s (config) recording window; the key re-renders as a
   recording indicator (red dot + countdown); press again to stop early.
2. Transcription is inserted into the still-held decision:
   `decision: { behavior: "deny", message: "<transcribed reason>" }` — the
   PermissionRequest hook is still parked during recording, so no keystroke
   delivery is involved and the reason reaches Claude as structured feedback.
3. Timeout with no/empty transcription → plain deny with the canned message
   (current stub behavior).

**Safety note:** the decision timeout keeps running while recording; if the
overall window expires the request falls through to the normal dialog —
recording never extends the hold beyond `decisionTimeoutSeconds`.

## Open questions for implementation time

- Mic capture while another app holds the device (exclusive-mode conflicts).
- Whether to show live partial transcription on the key faces (nice, but
  chatty over WS; likely render on the web deck only).
- Wake-word-free false-press guard: require ≥300ms hold before recording.
