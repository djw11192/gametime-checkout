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
import type { InMemoryAnalyticsSink } from "../ports/analytics";
import type { Clock } from "../ports/clock";
import type { InventoryProvider } from "../ports/inventory";
import type { PaymentProvider } from "../ports/payment";
import type { PricingProvider } from "../ports/pricing";
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
  pricing: PricingProvider;
  payments: PaymentProvider;
  analytics: InMemoryAnalyticsSink;
  clock: Clock;
}

export interface CompleteOutcome {
  view: CheckoutSessionView;
  order: Order | null;
  httpStatus: 200 | 201 | 202;
}

/** A resume: the surface changed, or enough time passed to count as an interruption. */
const RESUME_GAP_SECONDS = 30;

export class CheckoutService {
  /** Dedupe keys for `drift_shown`, so reads don't inflate the counter. */
  private readonly seenDrift = new Set<string>();

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
      quote: this.deps.pricing.quoteFromListing(listing, req.quantity),
      surface: req.surface,
      now: this.deps.clock.now(),
    });

    await this.deps.sessions.insert(session);
    this.deps.analytics.track({
      name: "session_created",
      at: this.deps.clock.nowIso(),
      sessionId: session.id,
      surface: req.surface,
    });

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

    // Lazy expiry. The sweeper handles idle sessions, but a read must never
    // return a live-looking session whose clock has run out.
    //
    // Held off by the completion grace so that a poll from the fan's other
    // device cannot kill a session while their submit is still in flight. The
    // view is unaffected: `buildView` reads the deadline without the grace, so
    // this still renders as expired — it just is not yet written down, which
    // leaves the completion path free to honour a request that beat the clock.
    if (
      session.status === "active" &&
      effectiveStatus(session, this.deps.clock.now(), COMPLETION_GRACE_MS) === "expired"
    ) {
      session = await this.applyInternal(sessionId, { type: "EXPIRE" });
    }

    if (context) session = await this.recordVisit(session, context);

    const view = await this.viewOf(session);
    if (context) this.trackDriftShown(view);
    return view;
  }

  /* ── Mutations ──────────────────────────────────────────────────────────── */

  async acknowledgeQuote(
    sessionId: string,
    req: AcknowledgeQuoteRequest,
  ): Promise<CheckoutSessionView> {
    const before = await this.requireSession(sessionId);
    const session = await this.applyClient(sessionId, {
      type: "ACKNOWLEDGE_QUOTE",
      quoteHash: req.quoteHash,
    });

    this.deps.analytics.track({
      name: "drift_accepted",
      at: this.deps.clock.nowIso(),
      sessionId,
      deltaCents: session.acceptedQuote.totalCents - before.acceptedQuote.totalCents,
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
   * ── Completion: four gates, each catching a case the next cannot ─────────
   *
   *   1. Idempotency key   — the same device retrying the same request.
   *   2. Terminal replay   — a request arriving after the order already exists.
   *   3. CAS into `completing` — two devices racing, milliseconds apart.
   *   4. Order uniqueness  — anything that got past 1–3.
   *
   * The critical detail is where the payment `await` sits: strictly after gate
   * 3. Authorizing first and recording the lock afterwards would leave the
   * entire slow authorization window open for a second device to walk through.
   */
  async completeSession(
    sessionId: string,
    req: CompleteSessionRequest,
    idempotencyKey: string,
  ): Promise<CompleteOutcome> {
    const { idempotency } = this.deps;

    // ── Gate 1 ──
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
    const { orders, payments, analytics, clock } = this.deps;
    const existing = await this.requireSession(sessionId);

    // ── Gate 2 ── Returning 200 with the order makes a late retry a success
    // from the caller's point of view, which is what it actually is.
    if (existing.status === "completed") {
      return {
        view: await this.viewOf(existing),
        order: orders.getBySession(sessionId),
        httpStatus: 200,
      };
    }

    // ── Gate 3 ── Take the lock before any slow work.
    let locked: CheckoutSession;
    try {
      locked = await this.applyClient(sessionId, {
        type: "BEGIN_COMPLETION",
        idempotencyKey,
        clientId: req.clientId,
        surface: req.surface,
        quoteHash: req.quoteHash,
      });
    } catch (error) {
      // Losing this race is a normal outcome — it is the system working.
      // Counting it makes cross-device contention observable.
      if (error instanceof ApiError && error.code === "COMPLETION_IN_PROGRESS") {
        const current = await this.deps.sessions.get(sessionId);
        analytics.track({
          name: "completion_blocked_duplicate",
          at: clock.nowIso(),
          sessionId,
          surface: req.surface,
          heldBySurface: current?.completion?.startedBySurface ?? req.surface,
        });
      }
      throw error;
    }

    analytics.track({ name: "completion_started", at: clock.nowIso(), sessionId, surface: req.surface });

    // The payment provider gets a *per-attempt* key, not the client's request
    // key. They guard different things: the request key makes one HTTP call
    // safe to retry, the authorization key makes one charge safe to retry.
    // Conflating them means a declined fan replays the decline forever, no
    // matter which card they try next. Gates 1 and 2 already ensure we only
    // reach here for a genuinely new attempt, so a fresh token is correct.
    const authorization = await payments.authorize({
      amountCents: locked.acceptedQuote.totalCents,
      idempotencyKey: `${idempotencyKey}:${randomUUID()}`,
    });

    if (authorization.status === "pending") {
      // Genuinely unresolved — a 3DS challenge or a bank hold. The session stays
      // locked, both surfaces show "processing", and nobody can start a second
      // attempt. This is the state naive models omit, and omitting it is how you
      // double-charge on a slow authorization.
      //
      // The id is written down before we return, because from here on the only
      // thing that can resolve this attempt is an inbound webhook on some other
      // request, and it will need a handle to release the hold.
      const recorded = await this.applyInternal(sessionId, {
        type: "RECORD_AUTHORIZATION",
        authorizationId: authorization.authorizationId,
      });
      return { view: await this.viewOf(recorded), order: null, httpStatus: 202 };
    }

    if (authorization.status !== "authorized") {
      const code = authorization.status === "declined" ? "payment_declined" : "payment_error";
      const settled = await this.settle(sessionId, {
        kind: "failed",
        code,
        message: authorization.reason,
        // Both are the fan's to retry: another card, or the same one once the
        // processor recovers.
        retryable: true,
      });
      analytics.track({
        name: "completion_failed",
        at: clock.nowIso(),
        sessionId,
        code,
        retryable: true,
      });
      return { view: await this.viewOf(settled), order: null, httpStatus: 200 };
    }

    return this.finalizeOrder(locked, req.surface, authorization.authorizationId);
  }

  /**
   * Commit inventory, write the order, settle the session.
   *
   * Shared by the synchronous path and the pending-authorization webhook, which
   * otherwise re-implement each other.
   *
   * ── The authorization invariant ────────────────────────────────────────────
   *
   * By the time this runs, a card is on the hook. So:
   *
   *   **Any exit from here that does not produce a new order for this attempt
   *   must release this attempt's authorization.**
   *
   * There are three such exits today — the seats went while we were at the
   * bank, an order for this session already existed, and an unexpected throw —
   * and the reason this is one `finally` over the whole body rather than a
   * `void()` on each branch is that a fourth exit added later would otherwise
   * silently skip it. The cost of forgetting is a real hold on a real card
   * belonging to someone who received nothing.
   */
  private async finalizeOrder(
    session: CheckoutSession,
    surface: Surface,
    authorizationId: string | null,
  ): Promise<CompleteOutcome> {
    const { orders, inventory, payments, analytics, clock } = this.deps;
    let orderPlaced = false;

    try {
      // ── Gate 4 ── The uniqueness invariant, checked before anything is
      // decremented. `orders.insert` below still throws — that is the real
      // invariant and it must stay — but reaching it with inventory already
      // committed means the seats were taken twice for one session.
      //
      // This check, the commit and the insert are all synchronous with no
      // `await` between them, so the three of them are one event-loop turn and
      // cannot interleave with a concurrent attempt. Against a database this is
      // one transaction; here it is the absence of a yield point.
      const alreadyPlaced = orders.getBySession(session.id);
      if (alreadyPlaced) {
        return {
          view: await this.getSession(session.id),
          order: alreadyPlaced,
          httpStatus: 200,
        };
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
        analytics.track({
          name: "completion_failed",
          at: clock.nowIso(),
          sessionId: session.id,
          code: "inventory_unavailable",
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
        // Unreachable from the check above unless the store is being written to
        // from somewhere that does not go through this method. Kept because it
        // is the only real invariant in the chain, and because handing back the
        // order that exists beats a 500 either way.
        return {
          view: await this.getSession(session.id),
          order: orders.get(error.existingOrderId),
          httpStatus: 200,
        };
      }
      orderPlaced = true;

      return await this.completeOrder(session, order, surface);
    } finally {
      if (!orderPlaced && authorizationId) await payments.void(authorizationId);
    }
  }

  private async completeOrder(
    session: CheckoutSession,
    order: Order,
    surface: Surface,
  ): Promise<CompleteOutcome> {
    const { analytics, clock } = this.deps;
    const settled = await this.settle(session.id, { kind: "succeeded", orderId: order.id });

    analytics.track({
      name: "completion_succeeded",
      at: clock.nowIso(),
      sessionId: session.id,
      surface,
      orderId: order.id,
      totalCents: order.totalCents,
      surfaceCount: settled.surfacesSeen.length,
    });

    return { view: await this.viewOf(settled), order, httpStatus: 201 };
  }

  /**
   * Resolve an authorization left `pending` — in production, the PSP's webhook
   * landing. Modelling it as an inbound call rather than polling is the honest
   * shape: the session sits locked until someone external says what happened.
   */
  async settlePendingAuthorization(sessionId: string, approve: boolean): Promise<CheckoutSessionView> {
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
   * event ever tells the open tabs. The sweep makes expiry an event rather than
   * a discovery.
   */
  async sweepExpired(): Promise<number> {
    // Held back by the grace for the same reason the lazy path is: the sweeper
    // ticks every second, so without this a submit landing inside its own grace
    // window would be a coin flip against a background job.
    const due = await this.deps.sessions.scanExpired(
      this.deps.clock.nowMs() - COMPLETION_GRACE_MS,
    );
    let swept = 0;

    for (const candidate of due) {
      try {
        const expired = await this.applyInternal(candidate.id, { type: "EXPIRE" });
        this.deps.analytics.track({
          name: "session_expired",
          at: this.deps.clock.nowIso(),
          sessionId: expired.id,
          surfaceCount: expired.surfacesSeen.length,
        });
        swept += 1;
      } catch {
        // Raced with a completion that won.
      }
    }
    return swept;
  }

  /**
   * Forget checkouts that have been finished long enough that nobody is coming
   * back for them.
   *
   * Deliberately not "delete on completion", which is the tempting reading of
   * "remove the session when the order is placed". A completed session is what
   * turns a late retry into `200 { order }` instead of a 404, and it is what the
   * fan's other device loads to render the confirmation it has not seen yet.
   * Deleting at completion makes a second tap look like a failure.
   *
   * So: terminal is a soft delete, and this is the hard one, a retention window
   * later. Against Redis none of this exists as a scan — the session gets an
   * `EXPIRE` the moment it goes terminal and the server forgets it for us.
   */
  async reapTerminal(): Promise<number> {
    const { sessions, idempotency, clock } = this.deps;
    const reapable = await sessions.scanReapable(clock.nowMs() - TERMINAL_RETENTION_MS);

    for (const session of reapable) {
      await sessions.delete(session.id);
      this.deps.bus.dropSession(session.id);
      // Drop this session's drift keys with it; otherwise the dedupe set is a
      // slow leak that outlives everything it was deduping.
      for (const key of this.seenDrift) {
        if (key.startsWith(`${session.id}:`)) this.seenDrift.delete(key);
      }
    }

    idempotency.expireBefore(clock.nowMs() - IDEMPOTENCY_RETENTION_MS);
    return reapable.length;
  }

  /**
   * Push every open session on a listing after the marketplace moved.
   *
   * Without this a fan learns the price changed only when they try to buy and
   * get a 409 — technically safe, but the worst possible moment to find out.
   */
  async notifyListingChanged(listingId: string): Promise<number> {
    const all = await this.deps.sessions.all();
    const affected = all.filter((s) => s.listingId === listingId && !isTerminal(s.status));

    for (const session of affected) {
      const view = await this.viewOf(session);
      this.deps.bus.publish(session.id, "quote.changed", view);
      this.trackDriftShown(view);
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
   * The single definition of "what is this listing worth right now".
   *
   * There must be exactly one. An earlier version had the view builder and the
   * state machine each deciding, and they disagreed on the sold-out case: the
   * API advertised a live price for tickets the reducer would refuse to sell,
   * which surfaces as a button that always 409s.
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
      liveQuote: this.deps.pricing.quoteFromListing(listing, session.quantity),
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
   * Apply a command on behalf of a client.
   *
   * On a lost compare-and-swap this re-reads and re-decides exactly once, and
   * the point is *which error the fan gets*, not the extra attempt.
   *
   * The version is the store's token, and it moves for reasons the client did
   * not cause — most writes here are `TOUCH`, recording that a surface looked.
   * So "your version was stale" is both unhelpful and often untrue in any sense
   * the fan would recognise: their phone loading the page is not a reason their
   * laptop cannot buy. Re-running the reducer against current state answers the
   * question they actually have. If it now refuses, its error is the honest one
   * — `COMPLETION_IN_PROGRESS`, `SESSION_EXPIRED`, `QUOTE_STALE` — and the
   * client already knows how to render each. If it still accepts, nothing was
   * in conflict and the write should just land.
   *
   * `VERSION_CONFLICT` therefore means only "two writers, twice, with the
   * reducer happy both times", which is a genuine last resort rather than the
   * catch-all it used to be.
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
   * Apply a server-originated command, retrying on conflict.
   *
   * These are transitions we owe the fan regardless — settling a payment we
   * already made, expiring a dead session. If a concurrent write bumps the
   * version, the right response is to re-read and re-decide, not to leave the
   * session wedged in `completing` with a real charge behind it.
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
   * Record that a surface opened this session, emitting `session_resumed` when
   * it qualifies.
   *
   * Writes are suppressed unless something meaningful changed. Every page load,
   * poll and reconnect lands here, and bumping the version each time would
   * churn the CAS token other requests hold, turning benign activity into
   * spurious 409s.
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

    if (surfaceChanged || gapSeconds >= RESUME_GAP_SECONDS) {
      this.deps.analytics.track({
        name: "session_resumed",
        at: now.toISOString(),
        sessionId: session.id,
        fromSurface: session.lastSeen.surface,
        toSurface: context.surface,
        gapSeconds: Math.round(gapSeconds),
        viaDeepLink: context.viaDeepLink ?? false,
      });
    }

    return this.applyInternal(session.id, {
      type: "TOUCH",
      surface: context.surface,
      at: now.toISOString(),
    });
  }

  /** Deduped, because this fires from reads and pushes alike; a counter that
   *  increments on every poll measures polling, not fans. */
  private trackDriftShown(view: CheckoutSessionView): void {
    const first = view.drift[0];
    if (!first) return;

    const signature = `${view.session.id}:${first.type}:${view.liveQuote?.hash ?? "gone"}`;
    if (this.seenDrift.has(signature)) return;
    this.seenDrift.add(signature);

    this.deps.analytics.track({
      name: "drift_shown",
      at: this.deps.clock.nowIso(),
      sessionId: view.session.id,
      driftType: first.type,
      deltaCents:
        first.type === "price_increased"
          ? first.deltaCents
          : first.type === "price_decreased"
            ? -first.deltaCents
            : 0,
    });
  }

  private async publish(session: CheckoutSession, events: SseEventType[]): Promise<void> {
    if (events.length === 0) return;
    const view = await this.viewOf(session);
    for (const type of events) this.deps.bus.publish(session.id, type, view);
  }
}
