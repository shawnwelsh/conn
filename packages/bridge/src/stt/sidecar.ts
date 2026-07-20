import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Logger } from "../log.js";

/**
 * Push-to-talk sidecar adapter — one persistent Python process (sidecar.py)
 * owning the microphone and a local faster-whisper model. JSON lines over
 * stdio, one response per command, mirroring the AHK daemon pattern.
 *
 * Status drives the mic key face:
 *  - "offline": not running (deps missing, crash, disabled) — key grayed.
 *  - "loading": spawned, model loading (first run downloads it).
 *  - "ready" / "recording" / "transcribing": the live dictation cycle.
 * Failure posture per the design doc: sidecar down → offline key; audio is
 * never queued silently.
 */
export type SttStatus = "offline" | "loading" | "ready" | "recording" | "transcribing";

const SIDECAR_PATH = join(dirname(fileURLToPath(import.meta.url)), "sidecar.py");
// stop → transcription of up to maxSeconds of audio on CPU; generous.
const STOP_TIMEOUT_MS = 30_000;
const CMD_TIMEOUT_MS = 5_000;

export interface SttConfig {
  python: string;
  model: string;
  language: string;
  /** sounddevice input device name/index; omit for the system default. */
  device?: string;
}

/** Interface the controller depends on — tests stub this. */
export interface SttEngine {
  readonly status: SttStatus;
  /** Optional respawn hook: a mic press while offline retries the sidecar. */
  ensureStarted?(): Promise<void>;
  start(): Promise<boolean>;
  stop(): Promise<string>;
  cancel(): Promise<void>;
}

export class SttSidecar implements SttEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private _status: SttStatus = "offline";
  private spawning = false;

  constructor(
    private readonly cfg: SttConfig,
    private readonly log: Logger,
    private readonly onStatus: (status: SttStatus) => void,
  ) {}

  get status(): SttStatus {
    return this._status;
  }

  private setStatus(s: SttStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.onStatus(s);
  }

  /** Spawn the sidecar; resolves once ready (or offline on failure). Safe to
   * call repeatedly — a mic press while offline retries the spawn. */
  async ensureStarted(): Promise<void> {
    if (this.proc || this.spawning) return;
    this.spawning = true;
    this.setStatus("loading");
    try {
      const args = [SIDECAR_PATH, "--model", this.cfg.model, "--language", this.cfg.language];
      if (this.cfg.device) args.push("--device", this.cfg.device);
      const proc = spawn(this.cfg.python, args, { stdio: "pipe", windowsHide: true });
      this.proc = proc;
      proc.stderr.setEncoding("utf8");
      createInterface({ input: proc.stderr }).on("line", (l) => this.log.info({ stt: l }, "stt sidecar"));
      proc.on("exit", (code) => {
        this.log.warn({ code }, "stt sidecar exited");
        this.proc = null;
        this.setStatus("offline");
      });
      const lines = createInterface({ input: proc.stdout });
      // First protocol line must be the ready event; the model load (and its
      // one-time download) can take a while — no timeout here, the key just
      // shows "loading".
      const ready = await new Promise<boolean>((resolve) => {
        lines.once("line", (l) => {
          try {
            resolve(JSON.parse(l)?.event === "ready");
          } catch {
            resolve(false);
          }
        });
        proc.once("exit", () => resolve(false));
      });
      if (!ready) {
        proc.kill();
        this.proc = null;
        this.setStatus("offline");
        return;
      }
      this.lines = lines;
      this.setStatus("ready");
      this.log.info({ model: this.cfg.model }, "stt sidecar ready");
    } catch (err) {
      this.log.warn({ err: String(err) }, "stt sidecar spawn failed");
      this.proc = null;
      this.setStatus("offline");
    } finally {
      this.spawning = false;
    }
  }

  private lines: ReturnType<typeof createInterface> | null = null;

  async start(): Promise<boolean> {
    if (this._status !== "ready") return false;
    const reply = await this.command({ cmd: "start" }, CMD_TIMEOUT_MS);
    if (reply?.ok === true) {
      this.setStatus("recording");
      return true;
    }
    return false;
  }

  async stop(): Promise<string> {
    if (this._status !== "recording") return "";
    this.setStatus("transcribing");
    const reply = await this.command({ cmd: "stop" }, STOP_TIMEOUT_MS);
    // Sidecar died mid-transcription → status already "offline"; don't lie.
    if (this.proc) this.setStatus("ready");
    return typeof reply?.text === "string" ? reply.text : "";
  }

  async cancel(): Promise<void> {
    if (this._status !== "recording") return;
    await this.command({ cmd: "cancel" }, CMD_TIMEOUT_MS);
    if (this.proc) this.setStatus("ready");
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
    this.setStatus("offline");
  }

  /** Serialized request/response — the sidecar answers strictly in order. */
  private command(req: object, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const exec = async (): Promise<Record<string, unknown> | null> => {
      if (!this.proc || !this.lines) return null;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.lines?.off("line", onLine);
          resolve(null);
        }, timeoutMs);
        const onLine = (line: string) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line));
          } catch {
            resolve(null);
          }
        };
        this.lines!.once("line", onLine);
        this.proc!.stdin.write(JSON.stringify(req) + "\n");
      });
    };
    const next = this.queue.then(exec, exec);
    this.queue = next.catch(() => {});
    return next as Promise<Record<string, unknown> | null>;
  }
}
