"""claude-deck STT sidecar — push-to-talk capture + local transcription.

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
    stream = sd.RawInputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        device=device,
        callback=on_audio,
    )
    stream.start()
    log(f"microphone open: {sd.query_devices(stream.device)['name']}")
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
            recording.set()
            out({"ok": True})
        elif cmd == "cancel":
            recording.clear()
            with lock:
                chunks.clear()
            out({"ok": True})
        elif cmd == "stop":
            recording.clear()
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
