import { randomUUID } from "node:crypto";
import {
  COMPLETION_GRACE_MS,
  IDEMPOTENCY_RETENTION_MS,
  TERMINAL_RETENTION_MS,
  isTerminal,
  type AcknowledgeQuoteRequest,
  type CheckoutSession,
  type CheckoutSessionView,
  type CompleteSessionRequest,
  type CreateSessionRequest,
  type Listing,
  type Order,
  type Quote,
  type SseEventType,
  type Surface,
} from "@gametime/contracts";
import {
  createSession,
  effectiveStatus,
  reduce,
  type Command,
  type SettlementResult,
} from "../domain/checkout-machine";
import { ApiError, toApiError } from "../domain/errors";
import { buildView } from "../domain/view";
import type { Clock } from "../ports/clock";
import type { InventoryProvider } from "../ports/inventory";
import type { PaymentProvider } from "../ports/payment";
import type { QuoteListing } from "../ports/pricing";
import type { SessionEventBus } from "../stores/event-bus";
import { DuplicateOrderError, type InMemoryOrderStore } from "../stores/order-store";
import type { InMemoryIdempotencyStore } from "../stores/idempotency-store";
import type { SessionStore } from "../stores/session-store";

export interface CheckoutServiceDeps {
  sessions: SessionStore;
  orders: InMemoryOrderStore;
  idempotency: InMemoryIdempotencyStore;
  bus: SessionEventBus;
  inventory: InventoryProvider;
  quoteListing: QuoteListing;
  payments: PaymentProvider;
  clock: Clock;
}

export interface CompleteOutcome {
  view: CheckoutSessionView;
  order: Order | null;
  httpStatus: 200 | 201 | 202;
}

/** A resume: the surface changed, or enough time passed to count as an interruption. */
const RESUME_GAP_SECONDS = 30;

/**
 * All the I/O. Reads state, hands it to the reducer, compare-and-swaps the
 * result, publishes what the reducer asked for. Every rule about what a fan may
 * do lives in `checkout-machine`, not here.
 */
export class CheckoutService {
  constructor(private readonly deps: CheckoutServiceDeps) {}

  /* ── Reads ──────────────────────────────────────────────────────────────── */

  async createSession(req: CreateSessionRequest): Promise<CheckoutSessionView> {
    const listing = this.deps.inventory.getListing(req.listingId);
    if (!listing || listing.availableQuantity < req.quantity) {
      throw new ApiError(
        "INVENTORY_UNAVAILABLE",
        listing
          ? `Only ${listing.availableQuantity} ticket(s) remain on this listing.`
          : "That listing is no longer available.",
      );
    }

    const session = createSession({
      id: randomUUID(),
      eventId: listing.eventId,
      listingId: listing.id,
      quantity: req.quantity,
      quote: this.deps.quoteListing(listing, req.quantity),
      surface: req.surface,
      now: this.deps.clock.now(),
    });

    await this.deps.sessions.insert(session);
    return this.viewOf(session);
  }

  /**
   * Resume. Both surfaces hit this on every load, so it does three things at
   * once: project current truth, lazily settle an elapsed TTL, and record that
   * a surface has seen this session.
   */
  async getSession(
    sessionId: string,
    context?: { surface: Surface; clientId: string; viaDeepLink?: boolean },
  ): Promise<CheckoutSessionView> {
    let session = await this.requireSession(sessionId);

    // The sweeper handles idle sessions, but a read must never return a
    // live-looking session whose clock has run out. Held off by the completion
    // grace so a poll from the fan's other device cannot kill a session while
    // their submit is still in flight — `buildView` reads the deadline without
    // the grace, so this still *renders* as expired either way.
    if (
      session.status === "active" &&
      effectiveStatus(session, this.deps.clock.now(), COMPLETION_GRACE_MS) === "expired"
    ) {
      try {
        session = await this.applyInternal(sessionId, { type: "EXPIRE" });
      } catch {
        // Raced the sweeper or a completion. A read must still return a view.
        session = await this.requireSession(sessionId);
      }
    }

    if (context) session = await this.recordVisit(session, context);
    return this.viewOf(session);
  }

  /* ── Mutations ──────────────────────────────────────────────────────────── */

  async acknowledgeQuote(
    sessionId: string,
    req: AcknowledgeQuoteRequest,
  ): Promise<CheckoutSessionView> {
    const session = await this.applyClient(sessionId, {
      type: "ACKNOWLEDGE_QUOTE",
      quoteHash: req.quoteHash,
    });
    return this.viewOf(session);
  }

  async extendSession(sessionId: string): Promise<CheckoutSessionView> {
    return this.viewOf(await this.applyClient(sessionId, { type: "EXTEND" }));
  }

  async cancelSession(sessionId: string): Promise<CheckoutSessionView> {
    return this.viewOf(await this.applyClient(sessionId, { type: "CANCEL" }));
  }

  /**
   * Four gates against a duplicate order, each catching what the next cannot:
   * the idempotency key (one device retrying), terminal replay (a request after
   * the order exists), the CAS into `completing` (two devices racing), and the
   * store's uniqueness constraint.
   *
   * The payment `await` sits strictly after the CAS. Authorizing first would
   * leave the whole slow authorization window open for a second device.
   */
  async completeSession(
    sessionId: string,
    req: CompleteSessionRequest,
    idempotencyKey: string,
  ): Promise<CompleteOutcome> {
    const { idempotency } = this.deps;

    const claim = idempotency.claim<CompleteOutcome>(
      idempotencyKey,
      { sessionId, quoteHash: req.quoteHash },
      this.deps.clock.nowMs(),
    );
    if (claim.outcome === "replay") return claim.response;
    if (claim.outcome === "in_flight") {
      throw new ApiError("COMPLETION_IN_PROGRESS", "This purchase is already being completed.");
    }
    if (claim.outcome === "mismatch") {
      throw new ApiError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used for a different request.",
      );
    }

    try {
      const outcome = await this.runCompletion(sessionId, req, idempotencyKey);

      // A retryable failure must not be pinned to the key, or the fan could
      // never try a different card without restarting checkout.
      if (outcome.view.session.completion?.failure?.retryable) idempotency.release(idempotencyKey);
      else idempotency.complete(idempotencyKey, outcome.httpStatus, outcome);

      return outcome;
    } catch (error) {
      idempotency.release(idempotencyKey);
      throw error;
    }
  }

  private async runCompletion(
    sessionId: string,
    req: CompleteSessionRequest,
    idempotencyKey: string,
  ): Promise<CompleteOutcome> {
    const { orders, payments } = this.deps;
    const existing = await this.requireSession(sessionId);

    // A late retry did succeed, so say so rather than reporting a conflict.
    if (existing.status === "completed") {
      return {
        view: await this.viewOf(existing),
        order: orders.getBySession(sessionId),
        httpStatus: 200,
      };
    }

    const locked = await this.applyClient(sessionId, {
      type: "BEGIN_COMPLETION",
      idempotencyKey,
      clientId: req.clientId,
      surface: req.surface,
      quoteHash: req.quoteHash,
    });

    // A per-attempt key, not the client's request key: the request key makes one
    // HTTP call safe to retry, this one makes one charge safe to retry. Sharing
    // them means a declined fan replays the decline whichever card they try next.
    const authorization = await payments.authorize({
      amountCents: locked.acceptedQuote.totalCents,
      idempotencyKey: `${idempotencyKey}:${randomUUID()}`,
    });

    if (authorization.status === "pending") {
      // 3DS or a bank hold. The session stays locked so nobody can start a
      // second attempt, and the id is written down because from here only an
      // inbound webhook can resolve the attempt — it will need a handle.
      const recorded = await this.applyInternal(sessionId, {
        type: "RECORD_AUTHORIZATION",
        authorizationId: authorization.authorizationId,
      });
      return { view: await this.viewOf(recorded), order: null, httpStatus: 202 };
    }

    if (authorization.status !== "authorized") {
      const settled = await this.settle(sessionId, {
        kind: "failed",
        code: authorization.status === "declined" ? "payment_declined" : "payment_error",
        message: authorization.reason,
        // Both are the fan's to retry: another card, or the same one once the
        // processor recovers.
        retryable: true,
      });
      return { view: await this.viewOf(settled), order: null, httpStatus: 200 };
    }

    return this.finalizeOrder(locked, req.surface, authorization.authorizationId);
  }

  /**
   * Commit inventory, write the order, settle the session. Shared by the
   * synchronous path and the pending-authorization webhook.
   *
   * A card is on the hook by the time this runs, so any exit that does not
   * produce a new order must release this attempt's authorization. One `finally`
   * over the whole body rather than a `void()` per branch, so a fourth exit
   * added later cannot skip it.
   */
  private async finalizeOrder(
    session: CheckoutSession,
    surface: Surface,
    authorizationId: string | null,
  ): Promise<CompleteOutcome> {
    const { orders, inventory, payments, clock } = this.deps;
    let orderPlaced = false;

    try {
      // Checked before anything is decremented — reaching `orders.insert` with
      // inventory already committed means the seats were taken twice for one
      // session. This check, the commit and the insert have no `await` between
      // them, so they are one event-loop turn and cannot interleave with a
      // concurrent attempt. Against a database this is one transaction.
      const alreadyPlaced = orders.getBySession(session.id);
      if (alreadyPlaced) {
        return { view: await this.getSession(session.id), order: alreadyPlaced, httpStatus: 200 };
      }

      // Last check before money moves: inventory is third-party and can have
      // gone during the authorization round-trip.
      if (!inventory.commit(session.listingId, session.quantity)) {
        const settled = await this.settle(session.id, {
          kind: "failed",
          code: "inventory_unavailable",
          message: "These tickets sold before the purchase completed.",
          retryable: false,
        });
        return { view: await this.viewOf(settled), order: null, httpStatus: 200 };
      }

      let order: Order;
      try {
        order = orders.insert({
          id: `ord_${randomUUID().slice(0, 12)}`,
          sessionId: session.id,
          eventId: session.eventId,
          listingId: session.listingId,
          quantity: session.quantity,
          totalCents: session.acceptedQuote.totalCents,
          placedAt: clock.nowIso(),
          placedFromSurface: surface,
        });
      } catch (error) {
        if (!(error instanceof DuplicateOrderError)) throw error;
        // Only reachable if the store is written to from outside this method,
        // but it is the one real invariant in the chain and handing back the
        // order that exists beats a 500.
        return {
          view: await this.getSession(session.id),
          order: orders.get(error.existingOrderId),
          httpStatus: 200,
        };
      }
      orderPlaced = true;

      const settled = await this.settle(session.id, { kind: "succeeded", orderId: order.id });
      return { view: await this.viewOf(settled), order, httpStatus: 201 };
    } finally {
      if (!orderPlaced && authorizationId) await payments.void(authorizationId);
    }
  }

  /**
   * Resolve an authorization left `pending` — in production, the processor's
   * webhook landing. An inbound call rather than polling: the session sits
   * locked until something external says what happened.
   */
  async settlePendingAuthorization(
    sessionId: string,
    approve: boolean,
  ): Promise<CheckoutSessionView> {
    const session = await this.requireSession(sessionId);
    if (session.status !== "completing") {
      throw new ApiError("SESSION_TERMINAL", "No pending authorization on this checkout.");
    }

    if (!approve) {
      const settled = await this.settle(sessionId, {
        kind: "failed",
        code: "payment_declined",
        message: "The bank declined the authorization.",
        retryable: true,
      });
      // No void: the processor is telling us it declined, so there is no hold.
      if (session.completion) this.deps.idempotency.release(session.completion.idempotencyKey);
      return this.viewOf(settled);
    }

    const outcome = await this.finalizeOrder(
      session,
      session.completion?.startedBySurface ?? session.lastSeen.surface,
      session.completion?.authorizationId ?? null,
    );
    return outcome.view;
  }

  /* ── Expiry ─────────────────────────────────────────────────────────────── */

  /**
   * Lazy expiry alone is not enough: a fan who walks away and never touches the
   * page keeps a session that looks alive to every other surface, and no SSE
   * event ever tells the open tabs. This makes expiry an event, not a discovery.
   */
  async sweepExpired(): Promise<number> {
    // Held back by the grace for the same reason the lazy path is: this ticks
    // every second, so otherwise a submit landing inside its own grace window
    // would be a coin flip against a background job.
    const due = await this.deps.sessions.scanExpired(
      this.deps.clock.nowMs() - COMPLETION_GRACE_MS,
    );
    let swept = 0;

    for (const candidate of due) {
      try {
        await this.applyInternal(candidate.id, { type: "EXPIRE" });
        swept += 1;
      } catch {
        // Raced a completion that won.
      }
    }
    return swept;
  }

  /**
   * Forget checkouts finished long enough that nobody is coming back.
   *
   * Terminal is the soft delete and this is the hard one, a retention window
   * later: a completed session is what turns a late retry into `200 { order }`
   * and what the fan's other device loads to render a confirmation it has not
   * seen. Against Redis this is an `EXPIRE` set when the session goes terminal.
   */
  async reapTerminal(): Promise<number> {
    const { sessions, idempotency, clock } = this.deps;
    const reapable = await sessions.scanReapable(clock.nowMs() - TERMINAL_RETENTION_MS);

    for (const session of reapable) {
      await sessions.delete(session.id);
      this.deps.bus.dropSession(session.id);
    }

    idempotency.expireBefore(clock.nowMs() - IDEMPOTENCY_RETENTION_MS);
    return reapable.length;
  }

  /**
   * Push every open session on a listing after the marketplace moved. Without
   * this a fan learns the price changed when they try to buy and get a 409 —
   * safe, but the worst moment to find out.
   */
  async notifyListingChanged(listingId: string): Promise<number> {
    const all = await this.deps.sessions.all();
    const affected = all.filter((s) => s.listingId === listingId && !isTerminal(s.status));

    for (const session of affected) {
      this.deps.bus.publish(session.id, "quote.changed", await this.viewOf(session));
    }
    return affected.length;
  }

  /* ── Internals ──────────────────────────────────────────────────────────── */

  private async requireSession(sessionId: string): Promise<CheckoutSession> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) throw new ApiError("SESSION_NOT_FOUND", "We couldn't find that checkout.");
    return session;
  }

  /**
   * The single definition of what this listing is worth right now. The view
   * builder and the reducer must not each decide, or the API advertises a price
   * for tickets the reducer will refuse to sell.
   */
  private resolveLive(session: CheckoutSession): {
    listing: Listing | null;
    liveQuote: Quote | null;
    availableQuantity: number | null;
  } {
    const listing = this.deps.inventory.getListing(session.listingId);
    if (!listing || listing.availableQuantity <= 0) {
      return { listing, liveQuote: null, availableQuantity: listing?.availableQuantity ?? null };
    }
    return {
      listing,
      liveQuote: this.deps.quoteListing(listing, session.quantity),
      availableQuantity: listing.availableQuantity,
    };
  }

  /** The slice of current reality the reducer needs to decide. */
  private reduceContext(session: CheckoutSession) {
    const { liveQuote, availableQuantity } = this.resolveLive(session);
    return { now: this.deps.clock.now(), live: liveQuote, availableQuantity };
  }

  async viewOf(session: CheckoutSession): Promise<CheckoutSessionView> {
    const { listing, liveQuote } = this.resolveLive(session);
    return buildView({ session, listing, liveQuote, now: this.deps.clock.now() });
  }

  /**
   * Apply a command on behalf of a client, re-deciding once on a lost CAS.
   *
   * The point is which error the fan gets. The version moves for reasons they
   * did not cause — most writes here are `TOUCH`, recording that a surface
   * looked — so "your version was stale" is unhelpful and usually untrue in any
   * sense they would recognise. Re-running the reducer against current state
   * answers the question they actually have: if it now refuses, its error is the
   * honest one and the client already knows how to render it; if it accepts,
   * nothing was in conflict and the write should land.
   */
  private async applyClient(sessionId: string, command: Command): Promise<CheckoutSession> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.requireSession(sessionId);

      const result = reduce(session, command, this.reduceContext(session));
      if (!result.ok) throw toApiError(result.error);

      const cas = await this.deps.sessions.putIfVersion(result.next, session.version);
      if (cas.ok) {
        await this.publish(cas.session, result.emit);
        return cas.session;
      }
      if (cas.reason === "not_found") {
        throw new ApiError("SESSION_NOT_FOUND", "We couldn't find that checkout.");
      }
      if (attempt >= 1) {
        throw new ApiError("VERSION_CONFLICT", "This checkout was just changed on another device.");
      }
    }
  }

  /**
   * Apply a server-originated command, retrying on conflict. These are
   * transitions we owe the fan regardless — settling a payment we already made,
   * expiring a dead session — so a bumped version means re-read and re-decide
   * rather than leave the session wedged in `completing` with a charge behind it.
   */
  private async applyInternal(
    sessionId: string,
    command: Command,
    maxAttempts = 5,
  ): Promise<CheckoutSession> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const session = await this.requireSession(sessionId);
      const result = reduce(session, command, this.reduceContext(session));
      if (!result.ok) throw toApiError(result.error);

      const cas = await this.deps.sessions.putIfVersion(result.next, session.version);
      if (cas.ok) {
        await this.publish(cas.session, result.emit);
        return cas.session;
      }
      if (cas.reason === "not_found") {
        throw new ApiError("SESSION_NOT_FOUND", "We couldn't find that checkout.");
      }
    }
    throw new ApiError("VERSION_CONFLICT", "Could not apply update after repeated conflicts.");
  }

  private settle(sessionId: string, result: SettlementResult): Promise<CheckoutSession> {
    return this.applyInternal(sessionId, { type: "SETTLE_COMPLETION", result });
  }

  /**
   * Record that a surface opened this session.
   *
   * Suppressed unless something meaningful changed. Every page load, poll and
   * reconnect lands here, and bumping the version each time would churn the CAS
   * token other requests hold, turning benign activity into spurious 409s.
   */
  private async recordVisit(
    session: CheckoutSession,
    context: { surface: Surface; clientId: string; viaDeepLink?: boolean },
  ): Promise<CheckoutSession> {
    const now = this.deps.clock.now();
    const gapSeconds = (now.getTime() - new Date(session.lastSeen.at).getTime()) / 1000;
    const surfaceChanged = session.lastSeen.surface !== context.surface;
    const isNewSurface = !session.surfacesSeen.includes(context.surface);

    if (!surfaceChanged && !isNewSurface && gapSeconds < RESUME_GAP_SECONDS) return session;

    return this.applyInternal(session.id, {
      type: "TOUCH",
      surface: context.surface,
      at: now.toISOString(),
    });
  }

  private async publish(session: CheckoutSession, events: SseEventType[]): Promise<void> {
    if (events.length === 0) return;
    const view = await this.viewOf(session);
    for (const type of events) this.deps.bus.publish(session.id, type, view);
  }
}
