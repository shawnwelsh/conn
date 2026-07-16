import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRegistry } from "../registry.js";
import type { DeckLayerState } from "../layers.js";

/** Debug/UI surface: web deck static page + JSON state inspection. */
export async function registerApiRoutes(
  app: FastifyInstance,
  registry: SessionRegistry,
  layer: DeckLayerState,
): Promise<void> {
  await app.register(fastifyStatic, {
    root: resolve(dirname(fileURLToPath(import.meta.url)), "../../public"),
    index: ["deck.html"],
  });

  app.get("/api/state", async () => ({
    layer: {
      row1: layer.row1,
      row2: layer.row2,
      permission: layer.permission ?? null,
      question: layer.question ?? null,
      controls: layer.controls,
    },
    ...registry.snapshot(),
  }));

  app.get("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = registry.get(id);
    if (!session) return reply.code(404).send({ error: "unknown session" });
    return { sessionId: id, events: session.events.toArray() };
  });
}
