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
import type { AnalyticsSink } from "../ports/analytics";
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
  analytics: AnalyticsSink;
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
 * All the I/O. Reads the session, hands it to the state machine, writes the
 * result back, publishes the events the machine asked for.
 *
 * The rules about what a fan may do live in `checkout-machine`, not here.
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
   * Resume. Both surfaces call this on every load, so despite being a "read" it
   * does three things: builds the current view, expires the session if its
   * deadline has passed, and records that this surface looked.
   */
  async getSession(
    sessionId: string,
    context?: { surface: Surface; clientId: string; viaDeepLink?: boolean },
  ): Promise<CheckoutSessionView> {
    let session = await this.requireSession(sessionId);

    // A read must never return a session that looks alive but has run out.
    // Uses the grace period (see `COMPLETION_GRACE_MS`) so that a poll from the
    // fan's other device cannot expire a session while their submit is still in
    // flight. It still renders as expired either way, because `buildView`
    // measures the deadline without the grace.
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
   * Separate guards stop a duplicate order, each catching what the others cannot:
   *
   *   1. `Idempotency-Key` — the same device retrying the same request.
   *   2. The already-completed check in `runCompletion` — a request arriving
   *      after the order exists.
   *   3. The version check on the write into `completing` — two devices racing.
   *   4. The unique `sessionId` in the order store — the last resort.
   *
   * We call the payment provider only after guard 3 succeeds. Charging first
   * would leave the whole slow payment call open for a second device to start
   * its own attempt.
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
      this.deps.analytics.emit({ type: "duplicate.blocked", sessionId });
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

      // Release the key on a retryable failure, so the fan can try another card.
      // See `idempotency.release`.
      if (outcome.view.session.completion?.failure?.retryable) idempotency.release(idempotencyKey);
      else idempotency.complete(idempotencyKey, outcome.httpStatus, outcome);

      return outcome;
    } catch (error) {
      idempotency.release(idempotencyKey);
      // The other half of the metric: the claim above catches one device
      // retrying, this catches the second device that lost the race.
      if (error instanceof ApiError && error.code === "COMPLETION_IN_PROGRESS") {
        this.deps.analytics.emit({ type: "duplicate.blocked", sessionId });
      }
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

    // Two different keys, for two different things. The client's request key
    // makes one HTTP call safe to retry; this per-attempt key makes one charge
    // safe to retry. If they were the same, a fan whose card was declined would
    // replay that decline on every card they tried next.
    const authorization = await payments.authorize({
      amountCents: locked.acceptedQuote.totalCents,
      idempotencyKey: `${idempotencyKey}:${randomUUID()}`,
    });

    if (authorization.status === "pending") {
      // The bank wants the fan to confirm, or is holding the charge for review.
      // The session stays locked so nobody can start a second attempt, and we
      // save the authorization id because only an inbound webhook can resolve
      // this now — see `CompletionState.authorizationId`.
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
   * Commit inventory, write the order, settle the session. Shared by the normal
   * path and by the webhook that resolves a pending authorization.
   *
   * The fan's card is already authorized by the time this runs, so every exit
   * that does not produce an order has to release that hold. One `finally` over
   * the whole body rather than a release call per branch, so a new exit added
   * later cannot skip it.
   */
  private async finalizeOrder(
    session: CheckoutSession,
    surface: Surface,
    authorizationId: string | null,
  ): Promise<CompleteOutcome> {
    const { orders, inventory, payments, clock } = this.deps;
    let orderPlaced = false;

    try {
      // Checked before any inventory is decremented: reaching `orders.insert`
      // with inventory already committed would mean the seats were taken twice
      // for one session.
      //
      // This check, the commit and the insert have no `await` between them, so
      // nothing else can run in the middle and a concurrent attempt cannot slip
      // in. Against a real database this would be one transaction.
      const alreadyPlaced = orders.getBySession(session.id);
      if (alreadyPlaced) {
        return { view: await this.getSession(session.id), order: alreadyPlaced, httpStatus: 200 };
      }

      // Last check before the money moves. Inventory belongs to the seller and
      // can sell elsewhere while we are waiting on the bank.
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
        // Only reachable if something outside this method writes to the store.
        // Kept because it is the one guard a caller cannot bypass, and handing
        // back the order that already exists beats returning a 500.
        return {
          view: await this.getSession(session.id),
          order: orders.get(error.existingOrderId),
          httpStatus: 200,
        };
      }
      orderPlaced = true;

      // `surfaceCount > 1` means this checkout survived an interruption, which
      // is the number this feature is measured on.
      this.deps.analytics.emit({
        type: "checkout.completed",
        sessionId: session.id,
        surfaceCount: session.surfacesSeen.length,
      });

      const settled = await this.settle(session.id, { kind: "succeeded", orderId: order.id });

      // The seats just left the market. Every other fan holding a checkout on
      // this listing should hear it from us now, rather than from a 409 when
      // they press buy. Done after `settle` so this session is already terminal
      // and skipped by the filter below.
      await this.notifyListingChanged(session.listingId);

      return { view: await this.viewOf(settled), order, httpStatus: 201 };
    } finally {
      if (!orderPlaced && authorizationId) await payments.void(authorizationId);
    }
  }

  /**
   * Resolve an authorization left `pending`. In production this is the payment
   * processor's webhook arriving. We wait to be told rather than polling: the
   * session stays locked until something external says what happened.
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
      // Nothing to release: the processor is telling us it declined, so it
      // never placed a hold on the card.
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
   * Expire sessions on a timer, rather than only when someone reads them.
   *
   * A fan who walks away and never touches the page again would otherwise keep
   * a session that still looks alive to every other surface, with no event ever
   * telling the open tabs about it.
   */
  async sweepExpired(): Promise<number> {
    // Uses the grace period for the same reason the read path does. This ticks
    // every second, so without it a submit arriving inside its own grace window
    // would be a coin flip against this background job.
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
   * Give up on completion attempts that never came back.
   *
   * `sweepExpired` only looks at `active` sessions, and no command settles a
   * `completing` one except the request that started it — so an authorization
   * left `pending` by a webhook that never arrives, or a request that died
   * between taking the lock and settling, would otherwise hold the checkout
   * forever: never expired, never reaped, both surfaces stuck on "completing".
   *
   * Settling comes first and the release second, deliberately. `settle` is
   * compare-and-swap protected, so winning it is what proves no webhook is
   * about to resolve this attempt; voiding a hold we had not yet claimed the
   * right to void could cancel an authorization that then becomes an order.
   */
  async sweepStalledCompletions(): Promise<number> {
    const { sessions, payments, idempotency, clock } = this.deps;
    const stalled = await sessions.scanStalledCompletions(clock.nowMs());
    let swept = 0;

    for (const candidate of stalled) {
      try {
        await this.settle(candidate.id, {
          kind: "failed",
          code: "payment_error",
          // Not retryable: this checkout is over. The fan is told plainly
          // rather than left to wonder, and can start again at the live price.
          retryable: false,
          message: "We couldn't confirm this payment in time, so we released the hold.",
        });
      } catch {
        // Raced the webhook, or the original request finally settled. Either
        // way somebody else resolved this attempt and owns releasing it.
        continue;
      }

      // Only now that the outcome is committed. `void` is safe to call twice,
      // so a webhook arriving late cannot double-release.
      if (candidate.completion?.authorizationId) {
        await payments.void(candidate.completion.authorizationId);
      }
      if (candidate.completion) idempotency.release(candidate.completion.idempotencyKey);
      swept += 1;
    }
    return swept;
  }

  /**
   * Delete checkouts that finished long enough ago that nobody is coming back.
   *
   * Finishing a checkout only marks it done; this is what actually removes it,
   * `TERMINAL_RETENTION_MS` later. Against Redis this would be an `EXPIRE` set
   * at the moment the session finished.
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
   * Push the new quote to every open session on a listing after its price or
   * availability changed. Without this a fan only finds out when they try to
   * buy and get a 409 — safe, but the worst possible moment to learn it.
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
   * The one place that decides what this listing is worth right now. If the
   * view builder and the state machine each worked it out separately, the API
   * could advertise a price that the state machine then refuses to sell at.
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

  /** The current state of the world that the state machine needs to decide. */
  private reduceContext(session: CheckoutSession) {
    const { liveQuote, availableQuantity } = this.resolveLive(session);
    return { now: this.deps.clock.now(), live: liveQuote, availableQuantity };
  }

  async viewOf(session: CheckoutSession): Promise<CheckoutSessionView> {
    const { listing, liveQuote } = this.resolveLive(session);
    return buildView({ session, listing, liveQuote, now: this.deps.clock.now() });
  }

  /**
   * Apply a command on behalf of a client. If the write loses the version check,
   * re-read and decide once more before giving up.
   *
   * This retry is about which error the fan gets. The version moves for reasons
   * they did not cause — most writes here are `TOUCH`, just recording that a
   * surface loaded the page — so telling them "your version was stale" is both
   * unhelpful and usually untrue. Running the state machine again against the
   * current state answers their real question instead: if it now refuses, that
   * refusal is the accurate error and the client already knows how to show it;
   * if it accepts, there was no real conflict and the write should land.
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
   * Apply a command the server originated, retrying harder than `applyClient`.
   * These are transitions we owe the fan either way — settling a payment we
   * already took, expiring a dead session — so losing the version check means
   * re-read and try again, rather than leaving the session stuck in
   * `completing` with a real charge behind it.
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
   * Record that a surface opened this session, but only when something actually
   * changed. Every page load, poll and reconnect reaches this method, and
   * writing on each one would bump the version other in-flight requests are
   * holding, turning harmless activity into 409s.
   *
   * That same guard is why the resume metric is emitted here: anything getting
   * past it is a genuine surface switch or a return after a gap, not a refresh.
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

    this.deps.analytics.emit({
      type: "session.resumed",
      sessionId: session.id,
      fromSurface: session.lastSeen.surface,
      toSurface: context.surface,
      gapSeconds: Math.round(gapSeconds),
      viaDeepLink: context.viaDeepLink ?? false,
    });

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
