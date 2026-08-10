import { Router } from "express";
import type { Container } from "../container";
import { ApiError } from "../domain/errors";

export function catalogRouter(container: Container): Router {
  const router = Router();
  const { inventory } = container;

  router.get("/events", (_req, res) => {
    res.json({ events: inventory.listEvents() });
  });

  router.get("/events/:eventId", (req, res) => {
    const event = inventory.getEvent(req.params.eventId as string);
    if (!event) throw new ApiError("SESSION_NOT_FOUND", "Event not found.");
    res.json({ event, listings: inventory.listListingsForEvent(event.id) });
  });

  /** By id rather than filtered from the event list, because a checkout page
   *  must still describe a listing that has since sold out. */
  router.get("/listings/:listingId", (req, res) => {
    const listing = inventory.getListing(req.params.listingId as string);
    if (!listing) throw new ApiError("INVENTORY_UNAVAILABLE", "Listing not found.");
    res.json({ listing });
  });

  return router;
}
