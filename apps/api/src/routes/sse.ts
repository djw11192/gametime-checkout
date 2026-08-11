import { Router } from "express";
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS, type SseEnvelope } from "@gametime/contracts";
import type { Container } from "../container";

export function sseRouter(container: Container): Router {
  const router = Router();
  const { bus, checkout } = container;

  /**
   * The live update stream for one session.
   *
   * The browser handles reconnecting on its own: `EventSource` retries on the
   * `retry:` interval below and sends back the id of the last event it saw, as
   * a `Last-Event-ID` header. We send everything after that point, so a fan
   * whose phone slept through a price change is caught up as soon as the screen
   * comes back on.
   */
  router.get("/sessions/:sessionId/events", async (req, res) => {
    const sessionId = req.params.sessionId as string;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies buffer responses by default, which would turn a live stream
      // into one that arrives all at once when the connection closes.
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    /** Only real events get an `id:` line — see the note below. */
    const frame = (type: string, data: unknown, id?: number) => {
      res.write(
        `${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    };
    const send = (envelope: SseEnvelope) => frame(envelope.type, envelope, envelope.id);

    // Send the current state straight away, so a client never has to wait for
    // the next change to find out where things stand.
    //
    // Deliberately sent with no `id:` line. EventSource only updates its
    // "last event I saw" marker on messages that carry an id, so leaving it off
    // keeps that marker wherever the last real event put it. Giving this
    // message an id would drag the marker backwards on every reconnect, and the
    // next dropped connection would re-send the entire buffer instead of just
    // the missed events.
    try {
      const view = await checkout.getSession(sessionId);
      frame("session.updated", { type: "session.updated", view });
    } catch {
      frame("error", { code: "SESSION_NOT_FOUND" });
      return res.end();
    }

    const header = req.header("last-event-id");
    const unsubscribe = bus.subscribe(
      sessionId,
      send,
      header ? Number.parseInt(header, 10) : undefined,
    );

    // A line starting with `:` is a no-op message. It stops proxies closing the
    // connection for being idle, and EventSource ignores it entirely.
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), SSE_HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  return router;
}
