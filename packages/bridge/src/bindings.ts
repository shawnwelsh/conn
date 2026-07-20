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
  /** Window handle at spawn time — revalidated (never trusted) at restore.
   * WT windows can't be re-derived from the pid, so persisting is the only
   * way focus survives a restart there. */
  hwnd?: number;
  /** Hand-given name (deck Rename key) for sessions whose branch couldn't
   * carry it. Branch-renamed sessions need nothing here — the branch is the
   * name. */
  label?: string;
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

  /** Attach a hand-given name to an existing binding (no-op if untracked —
   * a desktop session has no console to persist against). */
  setLabel(cwd: string, label: string): void {
    const all = this.load();
    const match = all.find((b) => sameCwd(b.cwd, cwd));
    if (!match) return;
    match.label = label;
    this.save(all);
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
 * Boot-time restore: for each persisted binding whose PROCESS is still
 * alive, claim a provisional key (console-kind, bound) so the console is on
 * the deck immediately and the session's next hook adopts it in place —
 * exactly the New-key flow, minus the spawn. Dead ones are pruned.
 *
 * Liveness is the pid, not a window: a WT-hosted console's window belongs to
 * WindowsTerminal.exe and can never be re-derived from the session's pid.
 * The persisted hwnd is revalidated (stale handles get recycled); a conhost
 * session missing one falls back to findpid. No hwnd just means no
 * focus/surfacing — delivery injects by pid regardless.
 *
 * Claude Code fires no SessionStart at interactive launch, so an already-
 * running console may stay provisional until its next prompt/tool event —
 * commands still deliver, because the pid binding is what matters.
 */
export async function restoreConsoleBindings(
  store: BindingStore,
  registry: SessionRegistry,
  delivery: DeliveryAdapter,
  log: Logger,
): Promise<void> {
  for (const binding of store.load()) {
    const alive = await delivery.checkPid?.(binding.pid);
    if (alive === false) {
      store.removeByCwd(binding.cwd);
      log.info({ cwd: binding.cwd, pid: binding.pid }, "bindings: console gone — pruned");
      continue;
    }
    if (alive !== true) continue; // can't tell — keep the record, skip restore
    let hwnd: number | null = null;
    if (binding.hwnd && (await delivery.checkWindow(binding.hwnd)) === true) {
      hwnd = binding.hwnd;
    } else {
      hwnd = await delivery.findWindowByPid(binding.pid); // conhost fallback
    }
    const entry = registry.addProvisionalAt(binding.cwd);
    registry.bindProvisional(binding.cwd, { pid: binding.pid, hwnd });
    if (binding.label) registry.setLabelOverride(entry.sessionId, binding.label);
    log.info({ cwd: binding.cwd, pid: binding.pid, hwnd, label: binding.label }, "bindings: console restored");
  }
}
