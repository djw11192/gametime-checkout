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
 * The checkout state machine: a pure function. No clock, no store, no network —
 * `now` and the live quote arrive in the context, so everything that decides
 * whether a fan gets charged is testable as a table of inputs and outputs.
 *
 * If a rule looks like it wants to live in the service, it belongs here instead.
 */

export type Command =
  | { type: "TOUCH"; surface: Surface; at: string }
  | { type: "ACKNOWLEDGE_QUOTE"; quoteHash: string }
  | { type: "EXTEND" }
  /** Takes the single-flight lock. Must succeed before any payment call. */
  | {
      type: "BEGIN_COMPLETION";
      idempotencyKey: string;
      clientId: string;
      surface: Surface;
      quoteHash: string;
    }
  /**
   * Records the processor's handle for the authorization we just took, so a
   * later failure — or a webhook arriving on a different request — can release
   * it. The id does not exist until after the lock, hence a second write.
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
 * `graceMs` shifts the deadline later for callers that are deciding whether to
 * *honour* something already in flight, as opposed to deciding what to display.
 * Zero everywhere except the completion path — see `COMPLETION_GRACE_MS`.
 */
const hasElapsed = (session: CheckoutSession, now: Date, graceMs = 0) =>
  new Date(session.expiresAt).getTime() + graceMs <= now.getTime();

/**
 * The status a session *actually* has, as opposed to the one last written.
 * Expiry is the one transition no request triggers, so every read must account
 * for it; reading `session.status` directly outside this module is a bug.
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
      // Permitted on terminal sessions on purpose: "fan opened a dead checkout
      // on their phone" is what lets mobile show a recovery screen rather than
      // a 404. Records provenance only; never revives anything.
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
      // Acknowledging an already-stale hash is meaningless — the fan accepted a
      // number that is no longer on offer.
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
      // The single-flight guard: whoever CAS'd into `completing` first owns the
      // attempt, and everyone else is told who has it so they can say
      // "finishing on your other device" rather than surfacing an error.
      //
      // The only command that reads the deadline generously, because it is the
      // only one where the fan already acted before the clock ran out.
      const blocked = guard(COMPLETION_GRACE_MS);
      if (blocked) return fail(blocked);
      if (!ctx.live) return fail(gone());

      // Checked here and not left to the inventory commit downstream, because
      // by then we have authorized a card. A listing that is already too short
      // must never reach the payment provider.
      if (ctx.availableQuantity != null && ctx.availableQuantity < session.quantity) {
        return fail(short(ctx.availableQuantity, session.quantity));
      }

      // Both checks matter. The first stops a fan acting on an out-of-date
      // screen; the second stops a client quietly re-quoting and completing at a
      // price the fan was never shown.
      if (command.quoteHash !== ctx.live.hash) return fail(stale(ctx.live));
      if (session.acknowledgedQuoteHash !== ctx.live.hash) {
        return fail(stale(ctx.live, "The price changed and has not been accepted yet."));
      }

      return {
        ok: true,
        next: touch({
          ...session,
          status: "completing",
          // Taking the lock re-purposes the deadline: it stops being shopping
          // time and becomes this attempt's budget. `max` so a fan who extended
          // does not lose time, and not counted against `extensionsUsed`.
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
      // Emits nothing: the fan sees no change, and this exists so that whoever
      // has to release the authorization can find it.
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
      // A retryable failure hands the session back so the fan can try another
      // card, but only if there is time left — returning an elapsed session to
      // `active` would show a live checkout reading 0:00. Reaching `expired`
      // here means the attempt outlived the whole completion window, not merely
      // the original TTL, since `BEGIN_COMPLETION` pushed the deadline out.
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
      // Refused mid-authorization: we would not know whether the charge landed,
      // and "cancelled" next to a live bank hold is worse than saying nothing.
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
