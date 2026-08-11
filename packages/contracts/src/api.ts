import { z } from "zod";
import { SurfaceSchema, EventSchema, ListingSchema } from "./catalog";

/**
 * Request shapes. The API validates every incoming body against these, and the
 * web app parses every response through the schemas in ./session. Defined once
 * and used by both, so the two cannot drift apart.
 */

export const CreateSessionRequestSchema = z.object({
  listingId: z.string().min(1),
  quantity: z.number().int().positive().max(8),
  surface: SurfaceSchema,
  /** Per-tab identifier, so two tabs on one device are distinguishable. */
  clientId: z.string().min(1),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const AcknowledgeQuoteRequestSchema = z.object({
  /** The hash of the quote the fan is looking at as they accept it. */
  quoteHash: z.string().min(1),
  surface: SurfaceSchema,
  clientId: z.string().min(1),
});
export type AcknowledgeQuoteRequest = z.infer<typeof AcknowledgeQuoteRequestSchema>;

export const CompleteSessionRequestSchema = z.object({
  /** Must match the live quote, or the request is refused with QUOTE_STALE. */
  quoteHash: z.string().min(1),
  surface: SurfaceSchema,
  clientId: z.string().min(1),
});
export type CompleteSessionRequest = z.infer<typeof CompleteSessionRequestSchema>;

export const SimpleSessionRequestSchema = z.object({
  surface: SurfaceSchema,
  clientId: z.string().min(1),
});
export type SimpleSessionRequest = z.infer<typeof SimpleSessionRequestSchema>;

export const EventWithListingsSchema = z.object({
  event: EventSchema,
  listings: z.array(ListingSchema),
});
export type EventWithListings = z.infer<typeof EventWithListingsSchema>;

export const EventListResponseSchema = z.object({ events: z.array(EventSchema) });

/** Makes `complete` safe to retry over an unreliable network. */
export const HEADER_IDEMPOTENCY_KEY = "idempotency-key";

/* ── Scenario controls (development only) ─────────────────────────────────── */

export const PaymentModeSchema = z.enum(["approve", "decline", "pending", "slow", "error"]);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const SetPriceRequestSchema = z.object({
  listingId: z.string().min(1),
  /** Signed delta in cents applied to the per-ticket price. */
  deltaCents: z.number().int(),
});

export const SetInventoryRequestSchema = z.object({
  listingId: z.string().min(1),
  availableQuantity: z.number().int().nonnegative(),
});

export const SetPaymentModeRequestSchema = z.object({
  mode: PaymentModeSchema,
  latencyMs: z.number().int().nonnegative().optional(),
});

export const ExpireSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
  /** Seconds from now to move `expiresAt` to. 0 expires immediately. */
  inSeconds: z.number().int().nonnegative(),
});

export const SettlePendingRequestSchema = z.object({
  sessionId: z.string().min(1),
  approve: z.boolean().default(true),
});
