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
import { parseBody } from "./validate";

/**
 * ── Why there is no `If-Match` here ───────────────────────────────────────
 *
 * An earlier cut accepted `If-Match: <session version>` on every mutation. It
 * came out because no client could use it correctly: `GET /sessions/:id`
 * records that a surface looked, which is a write, so merely opening the
 * checkout on a phone advances the version a laptop is holding. A precondition
 * that a *third party glancing at their screen* invalidates produces 409s that
 * mean nothing to the fan, and the honest client behaviour is to ignore it.
 *
 * What each mutation actually needs is a precondition on the thing at risk,
 * which is narrower and stable under unrelated activity:
 *
 *   acknowledge / complete — `quoteHash`, so a fan cannot accept or be charged
 *                            a price that is no longer on offer
 *   complete               — the CAS into `completing`, for two devices racing
 *   complete               — `Idempotency-Key`, for one device retrying
 *   extend / cancel        — nothing; they are safe against any current state,
 *                            and the reducer refuses them on a dead session
 *
 * The version is still the store's concurrency token — every write goes through
 * `putIfVersion` — it is just not a useful *client* token.
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
