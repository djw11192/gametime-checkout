import { Router } from "express";
import {
  ExpireSessionRequestSchema,
  SetInventoryRequestSchema,
  SetPaymentModeRequestSchema,
  SetPriceRequestSchema,
} from "@gametime/contracts";
import type { Container } from "../container";
import { ApiError } from "../domain/errors";
import { parseBody } from "./validate";

/**
 * The levers behind `/demo`. These stand in for things that in production
 * happen because the world moved: a seller repricing, a listing selling on
 * another channel, a processor having a bad afternoon.
 *
 * Exposing them as an explicit dev-only API — rather than random jitter inside
 * the fakes — is what makes the state transitions reproducible enough to demo
 * and to assert on. Mounted only when NODE_ENV !== "production".
 */
export function scenarioRouter(container: Container): Router {
  const router = Router();
  const { inventory, payments, checkout, analytics, clock, sessions } = container;

  /** Move a listing's price; every open session on it is pushed the new quote. */
  router.post("/price", async (req, res) => {
    const body = parseBody(SetPriceRequestSchema, req.body);
    const listing = inventory.applyPriceDelta(body.listingId, body.deltaCents);
    if (!listing) throw new ApiError("INVENTORY_UNAVAILABLE", "Listing not found.");
    res.json({ listing, sessionsNotified: await checkout.notifyListingChanged(body.listingId) });
  });

  /** Zero simulates the listing selling elsewhere. */
  router.post("/inventory", async (req, res) => {
    const body = parseBody(SetInventoryRequestSchema, req.body);
    const listing = inventory.setAvailableQuantity(body.listingId, body.availableQuantity);
    if (!listing) throw new ApiError("INVENTORY_UNAVAILABLE", "Listing not found.");
    res.json({ listing, sessionsNotified: await checkout.notifyListingChanged(body.listingId) });
  });

  router.post("/payment-mode", (req, res) => {
    const body = parseBody(SetPaymentModeRequestSchema, req.body);
    payments.setMode(body.mode, body.latencyMs);
    res.json({ paymentMode: payments.getMode() });
  });

  /** Beats waiting ten real minutes, and exercises the sweeper rather than bypassing it. */
  router.post("/expire", async (req, res) => {
    const body = parseBody(ExpireSessionRequestSchema, req.body);
    const session = await sessions.get(body.sessionId);
    if (!session) throw new ApiError("SESSION_NOT_FOUND", "Session not found.");

    await sessions.putIfVersion(
      { ...session, expiresAt: new Date(clock.nowMs() + body.inSeconds * 1000).toISOString() },
      session.version,
    );
    if (body.inSeconds === 0) await checkout.sweepExpired();

    res.json({ session: await checkout.getSession(body.sessionId) });
  });

  /** Simulates the PSP webhook for an authorization left pending. */
  router.post("/settle-pending", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "");
    const view = await checkout.settlePendingAuthorization(sessionId, req.body?.approve !== false);
    res.json({ session: view });
  });

  router.post("/reset", async (_req, res) => {
    await container.reset();
    res.json({ ok: true });
  });

  router.post("/reset-analytics", (_req, res) => {
    analytics.clear();
    res.json({ ok: true });
  });

  return router;
}
