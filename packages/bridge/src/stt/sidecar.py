"""Conn STT sidecar — push-to-talk capture + local transcription.

Spawned once by the bridge. Owns the microphone (sounddevice) and a
faster-whisper model (CPU int8). Protocol: one JSON object per line.

  stdin:  {"cmd": "ping"}    -> {"ok": true}
          {"cmd": "start"}   -> {"ok": true}            (begin capture)
          {"cmd": "stop"}    -> {"text": "...", "ms": 812}
          {"cmd": "cancel"}  -> {"ok": true}            (discard capture)
  stdout: protocol lines only; {"event": "ready"} once the model is loaded.
          Logs go to stderr (the bridge forwards them to its log).

The model download (first run only) happens during load; the bridge shows
the key as "loading" until the ready event.
"""

import io
import json
import sys
import time
import wave
import argparse
import threading

SAMPLE_RATE = 16000


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"[stt] {msg}\n")
    sys.stderr.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="distil-small.en")
    ap.add_argument("--language", default="en")
    ap.add_argument("--device", default=None, help="sounddevice input device name/index")
    args = ap.parse_args()

    # Import late so a missing dependency produces a clean stderr line the
    # bridge can log, instead of a stack trace before stdio is wired.
    try:
        import sounddevice as sd
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        log(f"dependency import failed: {e}")
        sys.exit(2)

    log(f"loading model {args.model} (cpu int8)…")
    t0 = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    log(f"model loaded in {time.time() - t0:.1f}s")

    chunks: list[bytes] = []
    recording = threading.Event()
    lock = threading.Lock()

    def on_audio(indata, frames, t, status):  # noqa: ANN001
        if status:
            log(f"audio status: {status}")
        if recording.is_set():
            with lock:
                chunks.append(bytes(indata))

    device = None
    if args.device is not None:
        device = int(args.device) if args.device.isdigit() else args.device

    # The microphone is opened ON DEMAND, not at startup. Holding an input
    # stream open for the whole session lights the OS "in use" indicator and
    # claims the headset all day for a feature used in bursts — on a machine
    # whose owner is frequently on calls, that is not a reasonable default.
    # The MODEL stays loaded (that's the ~4s cost); opening a device is not.
    stream = None

    def open_mic() -> int:
        """Open + start the input stream. Returns ms taken."""
        nonlocal stream
        if stream is not None:
            return 0
        t0 = time.time()
        s = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            device=device,
            callback=on_audio,
        )
        s.start()
        stream = s
        ms = int((time.time() - t0) * 1000)
        log(f"microphone open: {sd.query_devices(s.device)['name']} ({ms}ms)")
        return ms

    def close_mic() -> None:
        nonlocal stream
        if stream is None:
            return
        s, stream = stream, None
        try:
            s.stop()
            s.close()
        except Exception as e:  # noqa: BLE001
            log(f"microphone close failed: {e}")
        else:
            log("microphone released")

    out({"event": "ready", "model": args.model})

    def transcribe(pcm: bytes) -> str:
        if len(pcm) < SAMPLE_RATE // 5 * 2:  # <200ms of audio — nothing to say
            return ""
        bio = io.BytesIO()
        with wave.open(bio, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm)
        bio.seek(0)
        segments, _info = model.transcribe(
            bio,
            language=args.language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line).get("cmd")
        except json.JSONDecodeError:
            out({"error": "bad json"})
            continue
        if cmd == "ping":
            out({"ok": True})
        elif cmd == "start":
            with lock:
                chunks.clear()
            # Open BEFORE replying: the deck only shows REC once this returns,
            # so the key can't invite speech into a device that isn't live yet.
            try:
                open_ms = open_mic()
            except Exception as e:  # noqa: BLE001
                log(f"microphone open failed: {e}")
                out({"ok": False, "error": "mic unavailable"})
                continue
            recording.set()
            out({"ok": True, "openMs": open_ms})
        elif cmd == "cancel":
            recording.clear()
            close_mic()
            with lock:
                chunks.clear()
            out({"ok": True})
        elif cmd == "stop":
            recording.clear()
            # Release the device before transcribing — transcription takes far
            # longer than recording, and nothing needs the mic during it.
            close_mic()
            with lock:
                pcm = b"".join(chunks)
                chunks.clear()
            t0 = time.time()
            try:
                text = transcribe(pcm)
            except Exception as e:  # noqa: BLE001
                log(f"transcription failed: {e}")
                text = ""
            out({"text": text, "ms": int((time.time() - t0) * 1000)})
        else:
            out({"error": f"unknown cmd: {cmd}"})


if __name__ == "__main__":
    main()
