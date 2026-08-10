import { Router } from "express";
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS, type SseEnvelope } from "@gametime/contracts";
import type { Container } from "../container";

export function sseRouter(container: Container): Router {
  const router = Router();
  const { bus, checkout } = container;

  /**
   * The live channel for one session.
   *
   * Reconnection is handled entirely by the browser: `EventSource` retries on
   * the `retry:` interval and sends back the id of the last event it processed
   * as `Last-Event-ID`. We replay from the ring buffer past that point, so a fan
   * whose phone slept through a price change is caught up the moment the screen
   * comes back on.
   */
  router.get("/sessions/:sessionId/events", async (req, res) => {
    const sessionId = req.params.sessionId as string;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies buffer by default, which turns a live stream into one that
      // arrives all at once when it closes.
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const send = (envelope: SseEnvelope) => {
      res.write(`id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
    };

    // Current state immediately, so a subscriber is never waiting on the next
    // mutation to learn where things stand.
    try {
      const view = await checkout.getSession(sessionId);
      send({ id: 0, type: "session.updated", view });
    } catch {
      res.write(`event: error\ndata: {"code":"SESSION_NOT_FOUND"}\n\n`);
      return res.end();
    }

    const header = req.header("last-event-id");
    const unsubscribe = bus.subscribe(
      sessionId,
      send,
      header ? Number.parseInt(header, 10) : undefined,
    );

    // Comment frames keep intermediaries from closing an idle connection;
    // EventSource ignores them, so they cost nothing on the client.
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), SSE_HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  return router;
}
