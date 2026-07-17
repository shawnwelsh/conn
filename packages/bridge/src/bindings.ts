import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRegistry } from "./registry.js";
import type { DeliveryAdapter } from "./delivery/adapter.js";
import type { Logger } from "./log.js";

/**
 * Console bindings persisted across bridge restarts.
 *
 * The registry is in-memory: without this, a restart forgets that a session
 * lives in its own console window, the session re-registers as windowKind
 * "desktop" with no HWND, and its commands fall back to the Claude desktop
 * app — typed into whatever conversation happens to be visible. Persisting
 * {cwd, pid} lets boot re-resolve the window (pid → hwnd via the daemon,
 * never a stale stored hwnd — handles are recycled) and restore the key.
 */

export interface PersistedBinding {
  cwd: string;
  pid: number;
  at: number;
}

export class BindingStore {
  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  load(): PersistedBinding[] {
    try {
      if (!existsSync(this.file)) return [];
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (b): b is PersistedBinding =>
          typeof b?.cwd === "string" && Number.isInteger(b?.pid) && b.pid > 0,
      );
    } catch (err) {
      this.log.warn({ err: String(err), file: this.file }, "bindings: load failed — starting empty");
      return [];
    }
  }

  /** Add or replace the binding for a cwd (one console per working tree). */
  upsert(binding: PersistedBinding): void {
    const rest = this.load().filter((b) => !sameCwd(b.cwd, binding.cwd));
    this.save([...rest, binding]);
  }

  removeByCwd(cwd: string): void {
    const all = this.load();
    const rest = all.filter((b) => !sameCwd(b.cwd, cwd));
    if (rest.length !== all.length) this.save(rest);
  }

  private save(bindings: PersistedBinding[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(bindings, null, 2));
    } catch (err) {
      this.log.warn({ err: String(err), file: this.file }, "bindings: save failed");
    }
  }
}

function sameCwd(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Boot-time restore: for each persisted binding whose process still owns a
 * window, claim a provisional key (console-kind, bound) so the console is on
 * the deck immediately and the session's next hook adopts it in place —
 * exactly the New-key flow, minus the spawn. Dead ones are pruned.
 *
 * Claude Code fires no SessionStart at interactive launch, so an already-
 * running console may stay provisional until its next prompt/tool event —
 * commands still deliver, because the window binding is what matters.
 */
export async function restoreConsoleBindings(
  store: BindingStore,
  registry: SessionRegistry,
  delivery: DeliveryAdapter,
  log: Logger,
): Promise<void> {
  for (const binding of store.load()) {
    const hwnd = await delivery.findWindowByPid(binding.pid);
    if (!hwnd) {
      store.removeByCwd(binding.cwd);
      log.info({ cwd: binding.cwd, pid: binding.pid }, "bindings: console gone — pruned");
      continue;
    }
    registry.addProvisionalAt(binding.cwd);
    registry.bindProvisional(binding.cwd, { pid: binding.pid, hwnd });
    log.info({ cwd: binding.cwd, pid: binding.pid, hwnd }, "bindings: console restored");
  }
}
