import { z } from "zod";

/**
 * The marketplace side of the world: what is for sale right now. Nothing here
 * belongs to a checkout — a listing can be repriced or sold on another channel
 * while a fan is mid-purchase, which is the reason this prototype exists.
 */

export const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  venueName: z.string(),
  city: z.string(),
  state: z.string(),
  startsAt: z.string(),
});
export type EventRecord = z.infer<typeof EventSchema>;

export const ListingSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  section: z.string(),
  row: z.string(),
  /** Drops to 0 when the seller moves the tickets elsewhere. */
  availableQuantity: z.number().int().nonnegative(),
  /** Integer cents. Never a float, never client-supplied. */
  pricePerTicketCents: z.number().int().nonnegative(),
  feesPerTicketCents: z.number().int().nonnegative(),
  deliveryType: z.enum(["mobile_transfer", "instant_download"]),
  disclosures: z.array(z.string()),
});
export type Listing = z.infer<typeof ListingSchema>;

export const SurfaceSchema = z.enum(["web", "mobile"]);
export type Surface = z.infer<typeof SurfaceSchema>;
