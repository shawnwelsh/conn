/**
 * Phase 0 hook probe — zero-dependency capture server.
 *
 * Receives Claude Code `http` hooks, logs every raw payload (console +
 * probe-log.jsonl next to this script's cwd), and lets us exercise the
 * PermissionRequest response paths before any real bridge code exists.
 *
 * Usage:
 *   node scripts/probe-hooks.mjs                        # defer mode: 200 {} to everything
 *   PROBE_PERMISSION_MODE=hold  node scripts/probe-hooks.mjs   # hold permission-request 10s, then {}
 *   PROBE_PERMISSION_MODE=allow node scripts/probe-hooks.mjs   # respond allow decision (schema test)
 *   PROBE_PERMISSION_MODE=deny  node scripts/probe-hooks.mjs   # respond deny decision (schema test)
 *   PROBE_HOLD_SECONDS=20 PROBE_PORT=3711 ...                  # overrides
 *
 * SAFETY: "allow" mode exists ONLY to verify the decision JSON schema against
 * a scratch session running a harmless command (echo). It is a probe, not a
 * feature; the real bridge never auto-decides anything.
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.PROBE_PORT ?? 3711);
const MODE = process.env.PROBE_PERMISSION_MODE ?? "defer"; // defer | hold | allow | deny
const HOLD_SECONDS = Number(process.env.PROBE_HOLD_SECONDS ?? 10);
const LOG_FILE = "probe-log.jsonl";

function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function respond(res, body) {
  const json = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(json);
  return json;
}

const decisions = {
  allow: {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  },
  deny: {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Denied by belay probe" },
    },
  },
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { unparseable: raw };
    }
    const event = payload?.hook_event_name ?? "?";
    log({ url: req.url, event, payload });

    if (req.url === "/hooks/permission-request") {
      if (MODE === "allow" || MODE === "deny") {
        const sent = respond(res, decisions[MODE]);
        log({ url: req.url, responded: sent });
      } else if (MODE === "hold") {
        setTimeout(() => {
          respond(res, {});
          log({ url: req.url, responded: `{} after ${HOLD_SECONDS}s hold` });
        }, HOLD_SECONDS * 1000);
      } else {
        respond(res, {});
      }
      return;
    }
    respond(res, {});
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `probe listening on http://127.0.0.1:${PORT} — permission mode: ${MODE}` +
      (MODE === "hold" ? ` (${HOLD_SECONDS}s)` : ""),
  );
});
