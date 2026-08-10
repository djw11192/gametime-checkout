import { z } from "zod";
import { QuoteSchema } from "./quote";
import { SurfaceSchema } from "./catalog";

/**
 * Two orthogonal axes, the same split Stripe makes between a Checkout Session's
 * `status` and its `payment_status`:
 *
 *   1. `status`            — the lifecycle. Small, closed, exhaustively tested.
 *   2. `completion.status` — how the in-flight payment attempt is going.
 *
 * "Payment pending" is therefore not a lifecycle state; it is
 * `completing` + `completion.status: "pending"`. Collapsing the two axes is how
 * this kind of machine rots into `active_but_price_changed_and_payment_pending`.
 *
 *   active ──► completing ──► completed        (terminal)
 *     │            ├───────► active            (retryable failure — try another card)
 *     │            └───────► failed            (terminal failure)
 *     ├──────► expired                         (TTL elapsed)
 *     └──────► canceled
 */
export const SessionStatusSchema = z.enum([
  "active",
  "completing",
  "completed",
  "expired",
  "canceled",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

const TERMINAL: readonly SessionStatus[] = ["completed", "expired", "canceled", "failed"];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.includes(status);
}

export const FailureCodeSchema = z.enum([
  "payment_declined",
  "payment_error",
  "inventory_unavailable",
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

/**
 * The current or last completion attempt. Its presence is what makes the
 * single-flight lock observable to the other device: a refused surface reads
 * `startedBySurface` and renders "completing on your phone" instead of an error.
 */
export const CompletionStateSchema = z.object({
  idempotencyKey: z.string(),
  startedAt: z.string(),
  startedBySurface: SurfaceSchema,
  clientId: z.string(),
  status: z.enum(["pending", "succeeded", "failed"]),
  /**
   * The processor's handle on the money we are holding. Persisted rather than
   * kept in a local variable because the request that took the authorization is
   * often not the one that has to release it — a 3DS hold is resolved by an
   * inbound webhook minutes later.
   */
  authorizationId: z.string().nullable(),
  orderId: z.string().nullable(),
  failure: z
    .object({
      code: FailureCodeSchema,
      message: z.string(),
      /** Retryable failures return the session to `active`; terminal ones do not. */
      retryable: z.boolean(),
    })
    .nullable(),
});

/**
 * The persisted session: the fan's agreement, and nothing else.
 *
 * Note what is absent — no cached listing price, no `hasPriceChanged` flag, no
 * stored drift. Those are facts about the world right now, not about the
 * agreement, so they are recomputed on every read into a `CheckoutSessionView`.
 * Persisting a comparison is how you end up serving a "price went up!" banner
 * for a price that has since gone back down.
 */
export const CheckoutSessionSchema = z.object({
  /** The resume key: this id is the URL and the deep link. */
  id: z.string(),
  /**
   * Bumps on every write. The store's compare-and-swap token — not a client
   * one: a read records that a surface looked, so this moves for reasons the
   * client did not cause. It is also only half of the SSE staleness ordering,
   * because a price change re-projects the session without writing it; see
   * `mergeSessionView`.
   */
  version: z.number().int().nonnegative(),
  status: SessionStatusSchema,

  eventId: z.string(),
  listingId: z.string(),
  quantity: z.number().int().positive(),

  /** What the fan agreed to at creation, or last acknowledged. */
  acceptedQuote: QuoteSchema,
  acknowledgedQuoteHash: z.string(),

  /** Absolute and server-authoritative. Clients never compute this. */
  expiresAt: z.string(),
  extensionsUsed: z.number().int().nonnegative(),

  origin: z.object({ surface: SurfaceSchema, at: z.string() }),
  lastSeen: z.object({ surface: SurfaceSchema, at: z.string() }),
  /** Distinct surfaces seen — powers the continuity metric. */
  surfacesSeen: z.array(SurfaceSchema),

  completion: CompletionStateSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CheckoutSession = z.infer<typeof CheckoutSessionSchema>;

/** The diff between the fan's agreement and current reality. Never persisted. */
export const DriftSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("price_increased"),
    deltaCents: z.number().int().positive(),
    fromCents: z.number().int().nonnegative(),
    toCents: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("price_decreased"),
    deltaCents: z.number().int().positive(),
    fromCents: z.number().int().nonnegative(),
    toCents: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("quantity_reduced"),
    availableQuantity: z.number().int().nonnegative(),
    requestedQuantity: z.number().int().positive(),
  }),
  z.object({ type: z.literal("inventory_unavailable") }),
]);
export type Drift = z.infer<typeof DriftSchema>;

/** Why the primary CTA is inert. Rendered as the button's own label. */
export const BlockerCodeSchema = z.enum([
  "session_expired",
  "session_terminal",
  "completion_in_progress",
  "quote_unacknowledged",
  "inventory_unavailable",
]);
export type BlockerCode = z.infer<typeof BlockerCodeSchema>;

/**
 * What every session endpoint returns: agreement + current reality + verdict.
 *
 * `remainingMs` and `serverTime` exist so the first HTML byte can paint a real
 * countdown instead of `--:--`, and so the client can correct a skewed device
 * clock rather than trusting `Date.now()`.
 */
export const CheckoutSessionViewSchema = z.object({
  session: CheckoutSessionSchema,
  /** null when the listing is gone or sold out. */
  liveQuote: QuoteSchema.nullable(),
  drift: z.array(DriftSchema),
  remainingMs: z.number().int(),
  serverTime: z.string(),
  canComplete: z.boolean(),
  blockers: z.array(BlockerCodeSchema),
});
export type CheckoutSessionView = z.infer<typeof CheckoutSessionViewSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  /** Unique index — the last line of defence against a duplicate order. */
  sessionId: z.string(),
  eventId: z.string(),
  listingId: z.string(),
  quantity: z.number().int().positive(),
  totalCents: z.number().int().nonnegative(),
  placedAt: z.string(),
  placedFromSurface: SurfaceSchema,
});
export type Order = z.infer<typeof OrderSchema>;
