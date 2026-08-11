import { Router } from "express";
import {
  AcknowledgeQuoteRequestSchema,
  CompleteSessionRequestSchema,
  CreateSessionRequestSchema,
  HEADER_IDEMPOTENCY_KEY,
  SimpleSessionRequestSchema,
  SurfaceSchema,
} from "@gametime/contracts";
import type { Container } from "../container";
import { ApiError } from "../domain/errors";
import { parseBody } from "../lib/validate";

/**
 * Each write is guarded against the thing that can actually go wrong with it:
 *
 *   - `quoteHash` — anything that could charge a different amount.
 *   - the version check on `completing` — two devices racing each other.
 *   - `Idempotency-Key` — one device retrying the same request.
 *
 * There is deliberately no `If-Match` header on the session version; see the
 * README, and the test named for it in `checkout.integration.test.ts`.
 */
export function checkoutRouter(container: Container): Router {
  const router = Router();
  const { checkout } = container;

  router.post("/sessions", async (req, res) => {
    const view = await checkout.createSession(parseBody(CreateSessionRequestSchema, req.body));
    res.status(201).json({ session: view });
  });

  /**
   * Resume. Returns 200 even for expired, canceled and failed sessions.
   *
   * A device picking a checkout back up needs the event, the seats and the
   * current price to show a useful recovery screen ("this expired, those seats
   * are still available, start again"). A bare 404 would give it nothing to
   * render. Only an id we have never seen is a real 404.
   */
  router.get("/sessions/:sessionId", async (req, res) => {
    const surface = SurfaceSchema.safeParse(req.query.surface);
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;

    const view = await checkout.getSession(
      req.params.sessionId as string,
      surface.success && clientId
        ? { surface: surface.data, clientId, viaDeepLink: req.query.src === "deeplink" }
        : undefined,
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ session: view });
  });

  router.post("/sessions/:sessionId/acknowledge", async (req, res) => {
    const body = parseBody(AcknowledgeQuoteRequestSchema, req.body);
    res.json({ session: await checkout.acknowledgeQuote(req.params.sessionId as string, body) });
  });

  router.post("/sessions/:sessionId/extend", async (req, res) => {
    parseBody(SimpleSessionRequestSchema, req.body);
    res.json({ session: await checkout.extendSession(req.params.sessionId as string) });
  });

  router.post("/sessions/:sessionId/cancel", async (req, res) => {
    parseBody(SimpleSessionRequestSchema, req.body);
    res.json({ session: await checkout.cancelSession(req.params.sessionId as string) });
  });

  /**
   * Complete.
   *
   * 201 order created · 202 authorization pending · 200 resolved without a new
   * order (replay, or a handled failure).
   */
  router.post("/sessions/:sessionId/complete", async (req, res) => {
    const key = req.header(HEADER_IDEMPOTENCY_KEY);
    if (!key) throw new ApiError("VALIDATION_FAILED", "Idempotency-Key header is required.");

    const body = parseBody(CompleteSessionRequestSchema, req.body);
    const outcome = await checkout.completeSession(req.params.sessionId as string, body, key);
    res.status(outcome.httpStatus).json({ session: outcome.view, order: outcome.order });
  });

  return router;
}
