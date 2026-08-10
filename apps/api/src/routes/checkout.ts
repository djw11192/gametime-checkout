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
 * Each mutation's precondition guards the thing actually at risk: `quoteHash`
 * for anything that could charge a different number, the CAS into `completing`
 * for two devices racing, `Idempotency-Key` for one device retrying. There is
 * deliberately no `If-Match` on the session version — see the README.
 */
export function checkoutRouter(container: Container): Router {
  const router = Router();
  const { checkout } = container;

  router.post("/sessions", async (req, res) => {
    const view = await checkout.createSession(parseBody(CreateSessionRequestSchema, req.body));
    res.status(201).json({ session: view });
  });

  /**
   * Resume. Returns 200 even for expired, cancelled and failed sessions rather
   * than 404/410: a resuming surface needs the event, the seats and the current
   * price to render a useful recovery screen — "this expired, those seats are
   * still $563, start again" — and a bare 404 gives it nothing. Only an unknown
   * id is a genuine 404.
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
