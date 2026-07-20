/**
 * belay Elgato plugin — deliberately thin, by design and by contract:
 * it renders whatever the bridge sends and reports raw key presses back.
 * It speaks the SAME WebSocket protocol as the web debug deck; anything the
 * plugin can do, the web deck can do, and vice versa.
 *
 * Slot mapping: one action ("Deck Key") placed on every key of a 3×5
 * profile. Each instance derives its slot from its coordinates
 * (slot = row*5 + column) — no per-key configuration.
 */
import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyDownEvent,
  type KeyUpEvent,
} from "@elgato/streamdeck";
import WebSocket from "ws";

const BRIDGE_URL = process.env.CLAUDE_DECK_WS ?? "ws://127.0.0.1:3711/ws";
const COLS = 5;
const RECONNECT_MS = 2000;

/** slot → latest image data-URI, kept so keys repaint after (re)appear. */
const images = new Map<number, string>();
/** slot → visible action instance. */
const keys = new Map<number, { setImage(img: string): Promise<void> }>();

let ws: WebSocket | null = null;

function connect(): void {
  ws = new WebSocket(BRIDGE_URL);

  ws.on("open", () => {
    streamDeck.logger.info(`connected to bridge at ${BRIDGE_URL}`);
    ws?.send(JSON.stringify({ type: "identify", client: "streamdeck" }));
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    let msg: { type: string; keys?: Array<{ slot: number; image: string }> };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "render" && msg.keys) {
      for (const { slot, image } of msg.keys) {
        images.set(slot, image);
        void keys.get(slot)?.setImage(image);
      }
    }
  });

  const retry = () => {
    ws = null;
    setTimeout(connect, RECONNECT_MS);
  };
  ws.on("close", retry);
  ws.on("error", (err: Error) => {
    streamDeck.logger.warn(`bridge socket error: ${err.message}`);
    ws?.close();
  });
}

/** Multi-action instances have no coordinates — they can't be deck slots. */
function slotOf(payload: unknown): number | null {
  const coords = (payload as { coordinates?: { column: number; row: number } }).coordinates;
  if (!coords) return null;
  return coords.row * COLS + coords.column;
}

@action({ UUID: "com.shawnwelsh.belay.key" })
class DeckKey extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent): void {
    const slot = slotOf(ev.payload);
    if (slot === null) return;
    keys.set(slot, ev.action);
    const image = images.get(slot);
    if (image) void ev.action.setImage(image);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const slot = slotOf(ev.payload);
    if (slot !== null) keys.delete(slot);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.sendEdge(ev, "down");
  }

  override onKeyUp(ev: KeyUpEvent): void {
    this.sendEdge(ev, "up");
  }

  private sendEdge(ev: KeyDownEvent | KeyUpEvent, edge: "down" | "up"): void {
    const slot = slotOf(ev.payload);
    if (slot === null || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: edge, slot, at: Date.now() }));
  }
}

streamDeck.actions.registerAction(new DeckKey());
connect();
void streamDeck.connect();
