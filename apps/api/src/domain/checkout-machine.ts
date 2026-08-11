import {
  COMPLETION_GRACE_MS,
  COMPLETION_WINDOW_MS,
  MAX_EXTENSIONS,
  SESSION_EXTENSION_MS,
  SESSION_TTL_MS,
  isTerminal,
  type CheckoutSession,
  type FailureCode,
  type Quote,
  type SseEventType,
  type Surface,
} from "@gametime/contracts";
import { domainError, type DomainError } from "./errors";

/**
 * The checkout state machine. A pure function: the current time and the live
 * quote are passed in rather than read from a clock or a store, so every rule
 * that decides whether a fan gets charged can be tested as inputs and outputs.
 */

export type Command =
  | { type: "TOUCH"; surface: Surface; at: string }
  | { type: "ACKNOWLEDGE_QUOTE"; quoteHash: string }
  | { type: "EXTEND" }
  /** Locks the session to one attempt. Must succeed before any payment call. */
  | {
      type: "BEGIN_COMPLETION";
      idempotencyKey: string;
      clientId: string;
      surface: Surface;
      quoteHash: string;
    }
  /**
   * Saves the payment processor's id for the authorization we just took, so a
   * later failure — or a webhook arriving on a different request — can release
   * it. A second write because the id does not exist until after the lock.
   */
  | { type: "RECORD_AUTHORIZATION"; authorizationId: string }
  | { type: "SETTLE_COMPLETION"; result: SettlementResult }
  | { type: "CANCEL" }
  | { type: "EXPIRE" };

export type SettlementResult =
  | { kind: "succeeded"; orderId: string }
  | { kind: "failed"; code: FailureCode; message: string; retryable: boolean };

export type ReduceResult =
  | { ok: true; next: CheckoutSession; emit: SseEventType[] }
  | { ok: false; error: DomainError };

/**
 * Has the session's deadline passed?
 *
 * `graceMs` moves the deadline a little later. It is zero everywhere except the
 * completion path, which is the one case where the fan pressed the button
 * before the clock ran out and only our own network time made them late.
 * Refusing them there would punish them for our latency. Everywhere else — and
 * for anything the fan sees on screen — the deadline is the deadline.
 */
const hasElapsed = (session: CheckoutSession, now: Date, graceMs = 0) =>
  new Date(session.expiresAt).getTime() + graceMs <= now.getTime();

/**
 * The status a session actually has right now, which is not always the one last
 * written to it. Expiry is the only transition no request causes, so every read
 * has to work it out. Reading `session.status` directly outside this module is
 * a bug.
 */
export function effectiveStatus(session: CheckoutSession, now: Date, graceMs = 0) {
  if (session.status === "active" && hasElapsed(session, now, graceMs)) return "expired" as const;
  return session.status;
}

export function createSession(input: {
  id: string;
  eventId: string;
  listingId: string;
  quantity: number;
  quote: Quote;
  surface: Surface;
  now: Date;
}): CheckoutSession {
  const at = input.now.toISOString();
  return {
    id: input.id,
    version: 0,
    status: "active",
    eventId: input.eventId,
    listingId: input.listingId,
    quantity: input.quantity,
    acceptedQuote: input.quote,
    // Starting checkout *is* seeing and accepting the current price.
    acknowledgedQuoteHash: input.quote.hash,
    expiresAt: new Date(input.now.getTime() + SESSION_TTL_MS).toISOString(),
    extensionsUsed: 0,
    origin: { surface: input.surface, at },
    lastSeen: { surface: input.surface, at },
    surfacesSeen: [input.surface],
    completion: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function reduce(
  session: CheckoutSession,
  command: Command,
  ctx: {
    now: Date;
    live: Quote | null;
    /** Seats the seller still has, or null when the listing is gone entirely. */
    availableQuantity?: number | null;
  },
): ReduceResult {
  const at = ctx.now.toISOString();
  const touch = (next: CheckoutSession) => ({ ...next, updatedAt: at });

  /** Every command except TOUCH and SETTLE needs a live, unexpired session. */
  const guard = (graceMs = 0): DomainError | null => {
    const status = effectiveStatus(session, ctx.now, graceMs);
    if (status === "expired") return domainError("SESSION_EXPIRED", "This checkout has expired.");
    if (isTerminal(status)) return domainError("SESSION_TERMINAL", `This checkout is already ${status}.`);
    if (status === "completing") {
      return domainError("COMPLETION_IN_PROGRESS", "This purchase is already being completed.", {
        startedBySurface: session.completion?.startedBySurface ?? null,
      });
    }
    return null;
  };

  switch (command.type) {
    case "EXPIRE": {
      if (session.status !== "active") {
        return fail(domainError("SESSION_TERMINAL", `cannot expire a ${session.status} session`));
      }
      return { ok: true, next: touch({ ...session, status: "expired" }), emit: ["session.expired"] };
    }

    case "TOUCH": {
      // Allowed on finished sessions on purpose. "The fan opened a dead
      // checkout on their phone" is what lets mobile show a recovery screen
      // instead of a 404. Only records who looked; never revives anything.
      const surfacesSeen = session.surfacesSeen.includes(command.surface)
        ? session.surfacesSeen
        : [...session.surfacesSeen, command.surface];

      return {
        ok: true,
        next: touch({ ...session, lastSeen: { surface: command.surface, at: command.at }, surfacesSeen }),
        emit: [],
      };
    }

    case "ACKNOWLEDGE_QUOTE": {
      const blocked = guard();
      if (blocked) return fail(blocked);
      if (!ctx.live) return fail(gone());
      // The price moved again between us showing it and them accepting it.
      if (command.quoteHash !== ctx.live.hash) return fail(stale(ctx.live));

      return {
        ok: true,
        next: touch({ ...session, acceptedQuote: ctx.live, acknowledgedQuoteHash: ctx.live.hash }),
        emit: ["session.updated"],
      };
    }

    case "EXTEND": {
      const blocked = guard();
      if (blocked) return fail(blocked);
      if (session.extensionsUsed >= MAX_EXTENSIONS) {
        return fail(domainError("EXTENSION_LIMIT_REACHED", "This checkout cannot be extended again."));
      }

      return {
        ok: true,
        next: touch({
          ...session,
          expiresAt: new Date(
            new Date(session.expiresAt).getTime() + SESSION_EXTENSION_MS,
          ).toISOString(),
          extensionsUsed: session.extensionsUsed + 1,
        }),
        emit: ["session.updated"],
      };
    }

    case "BEGIN_COMPLETION": {
      // Whoever writes `completing` first owns the attempt. Everyone else is
      // told which surface has it, so they can say "finishing on your other
      // device" instead of showing an error.
      //
      // The only command that gets the grace period — see `hasElapsed`.
      const blocked = guard(COMPLETION_GRACE_MS);
      if (blocked) return fail(blocked);
      if (!ctx.live) return fail(gone());

      // Deliberately checked here rather than left to the inventory commit
      // later on, because by then we have already charged a card. A listing
      // that is short must never reach the payment provider.
      if (ctx.availableQuantity != null && ctx.availableQuantity < session.quantity) {
        return fail(short(ctx.availableQuantity, session.quantity));
      }

      // Both checks are needed. The first stops a fan acting on an out-of-date
      // screen. The second stops a client quietly fetching the new price and
      // completing at a number the fan was never shown.
      if (command.quoteHash !== ctx.live.hash) return fail(stale(ctx.live));
      if (session.acknowledgedQuoteHash !== ctx.live.hash) {
        return fail(stale(ctx.live, "The price changed and has not been accepted yet."));
      }

      return {
        ok: true,
        next: touch({
          ...session,
          status: "completing",
          // The deadline now means something different: not how long the fan
          // has to shop, but how long this attempt has to finish. `max` so a
          // fan who already extended does not lose time, and this does not
          // count against `extensionsUsed`.
          expiresAt: new Date(
            Math.max(
              new Date(session.expiresAt).getTime(),
              ctx.now.getTime() + COMPLETION_WINDOW_MS,
            ),
          ).toISOString(),
          // Pin the agreement to exactly what we are about to charge.
          acceptedQuote: ctx.live,
          completion: {
            idempotencyKey: command.idempotencyKey,
            startedAt: at,
            startedBySurface: command.surface,
            clientId: command.clientId,
            status: "pending",
            authorizationId: null,
            orderId: null,
            failure: null,
          },
        }),
        emit: ["completion.started"],
      };
    }

    case "RECORD_AUTHORIZATION": {
      if (session.status !== "completing" || !session.completion) {
        return fail(domainError("SESSION_TERMINAL", `no completion in flight (${session.status})`));
      }
      // Emits nothing, because the fan sees no change. This write exists only
      // so whoever has to release the authorization later can find its id.
      return {
        ok: true,
        next: touch({
          ...session,
          completion: { ...session.completion, authorizationId: command.authorizationId },
        }),
        emit: [],
      };
    }

    case "SETTLE_COMPLETION": {
      if (session.status !== "completing" || !session.completion) {
        return fail(domainError("SESSION_TERMINAL", `no completion in flight (${session.status})`));
      }

      if (command.result.kind === "succeeded") {
        return {
          ok: true,
          next: touch({
            ...session,
            status: "completed",
            completion: { ...session.completion, status: "succeeded", orderId: command.result.orderId },
          }),
          emit: ["completion.succeeded"],
        };
      }

      const { code, message, retryable } = command.result;
      // A retryable failure gives the session back so the fan can try another
      // card, but only if time is left: returning an already-elapsed session to
      // `active` would render a live checkout reading 0:00. Landing on
      // `expired` here means the attempt outlived the whole completion window,
      // not just the original deadline, since `BEGIN_COMPLETION` extended it.
      const nextStatus = retryable ? (hasElapsed(session, ctx.now) ? "expired" : "active") : "failed";

      return {
        ok: true,
        next: touch({
          ...session,
          status: nextStatus,
          completion: { ...session.completion, status: "failed", failure: { code, message, retryable } },
        }),
        emit:
          nextStatus === "expired"
            ? ["completion.failed", "session.expired"]
            : ["completion.failed"],
      };
    }

    case "CANCEL": {
      // Refused mid-payment: we would not know whether the charge went through,
      // and showing "canceled" next to a live hold on the fan's card is worse
      // than saying nothing at all.
      const blocked = guard();
      if (blocked) return fail(blocked);
      return { ok: true, next: touch({ ...session, status: "canceled" }), emit: ["session.updated"] };
    }
  }
}

const fail = (error: DomainError): ReduceResult => ({ ok: false, error });

const gone = () => domainError("INVENTORY_UNAVAILABLE", "These tickets are no longer available.");

const short = (availableQuantity: number, requestedQuantity: number) =>
  domainError(
    "INVENTORY_UNAVAILABLE",
    availableQuantity === 0
      ? "These tickets are no longer available."
      : `Only ${availableQuantity} of your ${requestedQuantity} tickets are still available.`,
    { availableQuantity, requestedQuantity },
  );

const stale = (live: Quote, message = "The price has changed.") =>
  domainError("QUOTE_STALE", message, { newTotalCents: live.totalCents });
