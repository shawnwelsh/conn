import pino from "pino";
import { mkdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DeckConfig } from "./config.js";

export type Logger = pino.Logger;

/** Roll bridge.log over past this size, keeping one previous generation. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

/**
 * Bound the log at startup. Capping the payloads slows the growth but does not
 * stop it: this bridge runs for weeks at a time, and an append-only file that
 * nothing ever truncates eventually blocks the event loop on every write —
 * which is exactly how a 251 MB bridge.log made the deck laggy. One previous
 * generation is kept, so recent history survives a roll.
 */
function rollIfHuge(file: string): void {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
    const previous = `${file}.1`;
    try { rmSync(previous); } catch { /* no previous generation yet */ }
    renameSync(file, previous);
  } catch {
    // No log yet, or it is locked — never let logging setup stop the bridge.
  }
}

export function createLogger(cfg: DeckConfig): Logger {
  mkdirSync(cfg.log.dir, { recursive: true });
  rollIfHuge(join(cfg.log.dir, "bridge.log"));
  const destination = pino.destination({
    dest: join(cfg.log.dir, "bridge.log"),
    mkdir: true,
    sync: false,
  });
  return pino(
    { level: cfg.log.level },
    pino.multistream([{ stream: destination }, { stream: process.stdout }]),
  );
}

/** Fixed-size per-session event history for the web deck's debug panel. */
export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  toArray(): readonly T[] {
    return this.buf;
  }
}
