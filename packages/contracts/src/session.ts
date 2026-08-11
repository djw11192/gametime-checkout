import { z } from "zod";
import { QuoteSchema } from "./quote";
import { SurfaceSchema } from "./catalog";

/**
 * Two independent things are being tracked. `status` is where the checkout is
 * in its life; `completion.status` is how the current payment attempt is going.
 *
 * So "payment pending" is not a status of its own — it is `completing` plus
 * `completion.status: "pending"`. Merging the two is how a state machine like
 * this ends up with values named `active_but_price_changed_and_payment_pending`.
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
 * The current or most recent completion attempt.
 *
 * Storing this on the session is what lets the other device see the lock: a
 * surface that gets refused reads `startedBySurface` and can show "completing
 * on your phone" instead of an error.
 */
export const CompletionStateSchema = z.object({
  idempotencyKey: z.string(),
  startedAt: z.string(),
  startedBySurface: SurfaceSchema,
  clientId: z.string(),
  status: z.enum(["pending", "succeeded", "failed"]),
  /**
   * The payment processor's id for the hold we have on the fan's card.
   *
   * Stored on the session rather than kept in a local variable because the
   * request that took the hold is often not the one that has to release it: if
   * the bank asks the fan to confirm, a webhook resolves it minutes later, on a
   * different request.
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
 * What we store for a checkout: the fan's agreement, and nothing else.
 *
 * Deliberately absent are the listing's current price, a `hasPriceChanged`
 * flag, and any stored drift. Those describe the world right now rather than
 * the agreement, so they are worked out fresh on every read — see
 * `CheckoutSessionView`.
 */
export const CheckoutSessionSchema = z.object({
  /** The resume key: this id is the URL and the deep link. */
  id: z.string(),
  /**
   * Bumped on every write. The store uses it to reject a write built from
   * stale data — see `putIfVersion`.
   *
   * Not a token the client should hold onto: even a read can write here (it
   * records that a surface looked), so this moves for reasons the client did
   * not cause. It is also only half of how the browser orders incoming
   * updates — see `mergeSessionView`.
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

/**
 * Drift: the difference between what the fan agreed to and what is true now.
 * Always recomputed, never stored.
 */
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

/** Why the buy button is disabled. Shown as the button's own label. */
export const BlockerCodeSchema = z.enum([
  "session_expired",
  "session_terminal",
  "completion_in_progress",
  "quote_unacknowledged",
  "inventory_unavailable",
]);
export type BlockerCode = z.infer<typeof BlockerCodeSchema>;

/**
 * What every session endpoint returns: what the fan agreed to, what is true
 * now, and whether they can still buy.
 *
 * `remainingMs` and `serverTime` are here so the very first HTML can show a
 * real countdown instead of `--:--`, and so the client can correct for a device
 * clock that is set wrong rather than trusting `Date.now()`.
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
  /** Unique: one order per session. See `InMemoryOrderStore`. */
  sessionId: z.string(),
  eventId: z.string(),
  listingId: z.string(),
  quantity: z.number().int().positive(),
  totalCents: z.number().int().nonnegative(),
  placedAt: z.string(),
  placedFromSurface: SurfaceSchema,
});
export type Order = z.infer<typeof OrderSchema>;
