import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeckConfig } from "./config.js";

export type Logger = pino.Logger;

export function createLogger(cfg: DeckConfig): Logger {
  mkdirSync(cfg.log.dir, { recursive: true });
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
