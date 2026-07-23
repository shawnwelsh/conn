import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { PROTOCOL_VERSION, GRID, type ServerMessage, type ClientMessage, type KeyRender } from "@conn/shared";
import type { Logger } from "../log.js";

/**
 * One protocol, N clients (web deck, Elgato plugin). Broadcasts renders,
 * funnels raw presses to the controller. Nothing here knows about layers.
 */
export class DeckSocketServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, string>(); // socket → client kind
  private lastRender: KeyRender[] = [];

  constructor(
    server: Server,
    private readonly log: Logger,
    private readonly onKey: (slot: number, edge: "down" | "up") => void,
    private readonly onClientCountChange: (count: number) => void,
  ) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Broadcast key renders; remembers the last full state so new clients get
   * an immediate snapshot. */
  broadcast(keys: KeyRender[], fullState: KeyRender[]): void {
    this.lastRender = fullState;
    if (!keys.length) return;
    this.send({ type: "render", keys });
  }

  private send(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.set(ws, "unknown");
    this.log.info({ clients: this.clients.size }, "deck client connected");
    ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, grid: GRID } satisfies ServerMessage));
    if (this.lastRender.length) {
      ws.send(JSON.stringify({ type: "render", keys: this.lastRender } satisfies ServerMessage));
    }
    this.onClientCountChange(this.clients.size);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        this.log.warn({ raw: String(raw) }, "unparseable client message");
        return;
      }
      if (msg.type === "identify") {
        this.clients.set(ws, msg.client);
        this.log.info({ client: msg.client }, "client identified");
      } else if (msg.type === "down" || msg.type === "up") {
        this.log.debug({ slot: msg.slot, edge: msg.type }, "key");
        this.onKey(msg.slot, msg.type);
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      this.log.info({ clients: this.clients.size }, "deck client disconnected");
      this.onClientCountChange(this.clients.size);
    });
    ws.on("error", (err) => this.log.warn({ err: String(err) }, "ws error"));
  }
}
