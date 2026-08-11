import { Router } from "express";
import {
  ExpireSessionRequestSchema,
  SetInventoryRequestSchema,
  SetPaymentModeRequestSchema,
  SetPriceRequestSchema,
  SettlePendingRequestSchema,
} from "@gametime/contracts";
import type { Container } from "../container";
import { ApiError } from "../domain/errors";
import { parseBody } from "../lib/validate";

/**
 * The controls behind `/demo`. They stand in for things that happen on their
 * own in production: a seller changing their price, a listing selling
 * elsewhere, the payment processor having problems.
 *
 * Triggered explicitly rather than randomly from inside the fakes, so a demo
 * and a test can both rely on exactly when they happen. Only mounted when
 * NODE_ENV is not "production".
 */
export function scenarioRouter(container: Container): Router {
  const router = Router();
  const { inventory, payments, checkout, clock, sessions } = container;

  /** Move a listing's price; every open session on it is pushed the new quote. */
  router.post("/price", async (req, res) => {
    const body = parseBody(SetPriceRequestSchema, req.body);
    const listing = inventory.applyPriceDelta(body.listingId, body.deltaCents);
    if (!listing) throw new ApiError("NOT_FOUND", "Listing not found.");
    res.json({ listing, sessionsNotified: await checkout.notifyListingChanged(body.listingId) });
  });

  /** Zero simulates the listing selling elsewhere. */
  router.post("/inventory", async (req, res) => {
    const body = parseBody(SetInventoryRequestSchema, req.body);
    const listing = inventory.setAvailableQuantity(body.listingId, body.availableQuantity);
    if (!listing) throw new ApiError("NOT_FOUND", "Listing not found.");
    res.json({ listing, sessionsNotified: await checkout.notifyListingChanged(body.listingId) });
  });

  router.post("/payment-mode", (req, res) => {
    const body = parseBody(SetPaymentModeRequestSchema, req.body);
    payments.setMode(body.mode, body.latencyMs);
    res.json({ paymentMode: payments.getMode() });
  });

  /** Beats waiting ten real minutes, and still goes through the expiry sweeper. */
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

  /** Stands in for the payment processor's webhook resolving a pending charge. */
  router.post("/settle-pending", async (req, res) => {
    const body = parseBody(SettlePendingRequestSchema, req.body);
    res.json({ session: await checkout.settlePendingAuthorization(body.sessionId, body.approve) });
  });

  return router;
}
