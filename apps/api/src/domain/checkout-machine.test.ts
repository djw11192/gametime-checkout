import { describe, expect, it } from "vitest";
import {
  COMPLETION_GRACE_MS,
  COMPLETION_WINDOW_MS,
  SESSION_TTL_MS,
  type CheckoutSession,
  type Quote,
  type SessionStatus,
} from "@gametime/contracts";
import { createSession, effectiveStatus, reduce, type Command } from "./checkout-machine";

/**
 * The state machine is a pure function, so these tests need no server and no
 * store. A ten-minute deadline is exercised by passing `reduce` a different
 * `now`.
 */

const T0 = new Date("2026-01-15T18:00:00.000Z");
const at = (msFromT0: number) => new Date(T0.getTime() + msFromT0);

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    listingId: "lst_1",
    quantity: 2,
    pricePerTicketCents: 10_000,
    feesPerTicketCents: 1_500,
    subtotalCents: 20_000,
    feesCents: 3_000,
    totalCents: 23_000,
    hash: "hash_original",
    ...overrides,
  };
}

function session(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  const base = createSession({
    id: "sess_1",
    eventId: "evt_1",
    listingId: "lst_1",
    quantity: 2,
    quote: quote(),
    surface: "web",
    now: T0,
  });
  return { ...base, ...overrides };
}

const beginCompletion = (quoteHash = "hash_original"): Command => ({
  type: "BEGIN_COMPLETION",
  idempotencyKey: "key_1",
  clientId: "client_1",
  surface: "web",
  quoteHash,
});

describe("createSession", () => {
  it("starts active, unversioned, and pre-acknowledged at the creation price", () => {
    const s = session();
    expect(s.status).toBe("active");
    expect(s.version).toBe(0);
    // Starting checkout counts as accepting the price, so there is no drift
    // banner on the very first render.
    expect(s.acknowledgedQuoteHash).toBe(s.acceptedQuote.hash);
    expect(s.surfacesSeen).toEqual(["web"]);
    expect(new Date(s.expiresAt).getTime() - T0.getTime()).toBe(SESSION_TTL_MS);
  });
});

describe("effectiveStatus", () => {
  it("reports an elapsed active session as expired without anyone writing to it", () => {
    const s = session();
    expect(effectiveStatus(s, at(SESSION_TTL_MS - 1))).toBe("active");
    expect(effectiveStatus(s, at(SESSION_TTL_MS))).toBe("expired");
  });
});

describe("the transition table", () => {
  /** Every (status, command) pair, asserted in one place. */
  const cases: Array<{
    from: SessionStatus;
    command: Command;
    expect: { ok: true; to: SessionStatus } | { ok: false; code: string };
  }> = [
    // from active
    { from: "active", command: beginCompletion(), expect: { ok: true, to: "completing" } },
    { from: "active", command: { type: "CANCEL" }, expect: { ok: true, to: "canceled" } },
    { from: "active", command: { type: "EXPIRE" }, expect: { ok: true, to: "expired" } },
    { from: "active", command: { type: "EXTEND" }, expect: { ok: true, to: "active" } },

    // from completing: only one attempt at a time
    {
      from: "completing",
      command: beginCompletion(),
      expect: { ok: false, code: "COMPLETION_IN_PROGRESS" },
    },
    {
      from: "completing",
      command: { type: "CANCEL" },
      expect: { ok: false, code: "COMPLETION_IN_PROGRESS" },
    },
    {
      from: "completing",
      command: { type: "EXTEND" },
      expect: { ok: false, code: "COMPLETION_IN_PROGRESS" },
    },
    {
      from: "completing",
      command: { type: "EXPIRE" },
      expect: { ok: false, code: "SESSION_TERMINAL" },
    },

    // terminal states reject everything
    ...(["completed", "canceled", "failed"] as const).flatMap((from) => [
      { from, command: beginCompletion(), expect: { ok: false as const, code: "SESSION_TERMINAL" } },
      { from, command: { type: "CANCEL" as const }, expect: { ok: false as const, code: "SESSION_TERMINAL" } },
      { from, command: { type: "EXTEND" as const }, expect: { ok: false as const, code: "SESSION_TERMINAL" } },
    ]),

    // `expired` is a finished state too, but always reports itself by name. It
    // is the one the fan can act on — start again on the same seats — so the
    // client has to tell it apart from "this order already happened".
    ...([beginCompletion(), { type: "CANCEL" as const }, { type: "EXTEND" as const }]).map(
      (command) => ({
        from: "expired" as const,
        command,
        expect: { ok: false as const, code: "SESSION_EXPIRED" },
      }),
    ),
  ];

  const label = (testCase: (typeof cases)[number]) =>
    `${testCase.from} + ${testCase.command.type} ${
      testCase.expect.ok ? `→ ${testCase.expect.to}` : `rejected (${testCase.expect.code})`
    }`;

  // One table rather than one test per row, so a regression shows up as the
  // rows that changed instead of twenty separate failures.
  it("holds for every pair", () => {
    const actual = cases.map((testCase) => {
      const completion =
        testCase.from === "completing"
          ? {
              idempotencyKey: "key_prev",
              startedAt: T0.toISOString(),
              startedBySurface: "mobile" as const,
              clientId: "other_device",
              status: "pending" as const,
              authorizationId: null,
              orderId: null,
              failure: null,
            }
          : null;

      const result = reduce(session({ status: testCase.from, completion }), testCase.command, {
        now: at(1_000),
        live: quote(),
      });

      return `${testCase.from} + ${testCase.command.type} ${
        result.ok ? `→ ${result.next.status}` : `rejected (${result.error.code})`
      }`;
    });

    expect(actual).toEqual(cases.map(label));
  });

  it("rejects an expired-but-unswept session as SESSION_EXPIRED, not SESSION_TERMINAL", () => {
    // The client needs the difference: expired can be recovered from by
    // starting again on the same seats, the others generally cannot.
    const result = reduce(session(), beginCompletion(), {
      now: at(SESSION_TTL_MS + COMPLETION_GRACE_MS + 1),
      live: quote(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_EXPIRED");
  });
});

/* ── the expiry boundary ──────────────────────────────────────────────────── */

describe("submitting as the clock runs out", () => {
  it("honors a purchase that lands just past the deadline", () => {
    // The fan pressed the button before the clock ran out; the rest of the
    // delay was ours. See `hasElapsed` for why this one command gets extra time.
    const result = reduce(session(), beginCompletion(), {
      now: at(SESSION_TTL_MS + COMPLETION_GRACE_MS - 1),
      live: quote(),
    });
    expect(result.ok).toBe(true);
  });

  it("gives only completion the benefit of the doubt", () => {
    // Extending or canceling inside the grace period is not a request that was
    // already on its way when the clock ran out — it is someone acting on a
    // dead screen. Only the purchase gets the extra time.
    const now = at(SESSION_TTL_MS + COMPLETION_GRACE_MS - 1);
    for (const command of [{ type: "EXTEND" } as const, { type: "CANCEL" } as const]) {
      const result = reduce(session(), command, { now, live: quote() });
      expect(result.ok, command.type).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("SESSION_EXPIRED");
    }
  });

  it("hands the attempt its own deadline once it holds the lock", () => {
    // Submitted with four seconds left. Taking the lock resets the deadline to
    // the completion window, because it is now measuring how long the payment
    // has, not how long the fan has.
    const started = reduce(session(), beginCompletion(), {
      now: at(SESSION_TTL_MS - 4_000),
      live: quote(),
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(new Date(started.next.expiresAt).getTime() - T0.getTime()).toBe(
      SESSION_TTL_MS - 4_000 + COMPLETION_WINDOW_MS,
    );
    // The extra time does not use up the one extension the fan is allowed.
    expect(started.next.extensionsUsed).toBe(0);
  });

  it("never shortens a deadline that was already further out", () => {
    const extended = reduce(session(), { type: "EXTEND" }, { now: at(1_000), live: quote() });
    expect(extended.ok).toBe(true);
    if (!extended.ok) return;

    const started = reduce(extended.next, beginCompletion(), { now: at(2_000), live: quote() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.next.expiresAt).toBe(extended.next.expiresAt);
  });
});

describe("price safety at the moment of purchase", () => {
  it("refuses a completion carrying a hash that is no longer live", () => {
    const result = reduce(session(), beginCompletion("hash_original"), {
      now: at(1_000),
      live: quote({ hash: "hash_new", totalCents: 26_000 }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("QUOTE_STALE");
      expect(result.error.details?.newTotalCents).toBe(26_000);
    }
  });

  it("refuses a live hash the fan has not acknowledged", () => {
    // A client could fetch the new hash and complete with it without ever
    // showing the fan the new price. Accepting a price has to be its own
    // explicit step, so the server refuses this.
    const result = reduce(
      session({ acknowledgedQuoteHash: "hash_original" }),
      beginCompletion("hash_new"),
      { now: at(1_000), live: quote({ hash: "hash_new", totalCents: 26_000 }) },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("QUOTE_STALE");
  });

  it("allows completion once the new price is acknowledged, and charges exactly that", () => {
    const live = quote({ hash: "hash_new", totalCents: 26_000 });
    const result = reduce(
      session({ acknowledgedQuoteHash: "hash_new" }),
      beginCompletion("hash_new"),
      { now: at(1_000), live },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("completing");
      // The agreement is pinned to what is about to be charged.
      expect(result.next.acceptedQuote.totalCents).toBe(26_000);
    }
  });

  it("refuses completion when the seller has fewer seats than the fan is buying", () => {
    // Without this check the purchase would charge the card and only then find
    // out the tickets were short, leaving a hold on money for seats that were
    // never going to exist.
    const result = reduce(session(), beginCompletion(), {
      now: at(1_000),
      live: quote(),
      availableQuantity: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVENTORY_UNAVAILABLE");
      expect(result.error.details).toMatchObject({ availableQuantity: 1, requestedQuantity: 2 });
    }
  });

  it("refuses completion when the listing has vanished entirely", () => {
    const result = reduce(session(), beginCompletion(), { now: at(1_000), live: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVENTORY_UNAVAILABLE");
  });

  it("rejects acknowledging a hash that is already stale", () => {
    const result = reduce(
      session(),
      { type: "ACKNOWLEDGE_QUOTE", quoteHash: "hash_stale" },
      { now: at(1_000), live: quote({ hash: "hash_current" }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("QUOTE_STALE");
  });
});

describe("settlement", () => {
  function completing(): CheckoutSession {
    const started = reduce(session(), beginCompletion(), { now: at(1_000), live: quote() });
    if (!started.ok) throw new Error("fixture failed to reach completing");
    return started.next;
  }

  it("success moves to completed and records the order id", () => {
    const result = reduce(
      completing(),
      { type: "SETTLE_COMPLETION", result: { kind: "succeeded", orderId: "ord_1" } },
      { now: at(2_000), live: quote() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("completed");
      expect(result.next.completion?.orderId).toBe("ord_1");
      expect(result.emit).toContain("completion.succeeded");
    }
  });

  it("a retryable decline hands the session back so the fan can try another card", () => {
    const result = reduce(
      completing(),
      {
        type: "SETTLE_COMPLETION",
        result: { kind: "failed", code: "payment_declined", message: "declined", retryable: true },
      },
      { now: at(2_000), live: quote() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("active");
      expect(result.next.completion?.failure?.retryable).toBe(true);
    }
  });

  it("a non-retryable failure is terminal", () => {
    const result = reduce(
      completing(),
      {
        type: "SETTLE_COMPLETION",
        result: {
          kind: "failed",
          code: "inventory_unavailable",
          message: "sold",
          retryable: false,
        },
      },
      { now: at(2_000), live: quote() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.status).toBe("failed");
  });

  it("a decline just past the original deadline still lets the fan try another card", () => {
    // Submitted with two seconds left; the processor took four to decline. The
    // session comes back as active so they can try another card, rather than
    // having to start over.
    const locked = reduce(session(), beginCompletion(), {
      now: at(SESSION_TTL_MS - 2_000),
      live: quote(),
    });
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;

    const result = reduce(
      locked.next,
      {
        type: "SETTLE_COMPLETION",
        result: { kind: "failed", code: "payment_declined", message: "declined", retryable: true },
      },
      { now: at(SESSION_TTL_MS + 2_000), live: quote() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("active");
      expect(new Date(result.next.expiresAt).getTime()).toBeGreaterThan(
        at(SESSION_TTL_MS + 2_000).getTime(),
      );
    }
  });

  it("a retryable failure that outlives the completion window expires instead of reviving", () => {
    // But the extra time is not unlimited. Handing back a session showing 0:00
    // with a working buy button would be worse than saying it is over.
    const lockedAt = SESSION_TTL_MS - 2_000;
    const locked = reduce(session(), beginCompletion(), { now: at(lockedAt), live: quote() });
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;

    const result = reduce(
      locked.next,
      {
        type: "SETTLE_COMPLETION",
        result: { kind: "failed", code: "payment_declined", message: "declined", retryable: true },
      },
      { now: at(lockedAt + COMPLETION_WINDOW_MS + 1), live: quote() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("expired");
      expect(result.emit).toContain("session.expired");
    }
  });

});

describe("TOUCH", () => {
  it("accumulates distinct surfaces without duplicating them", () => {
    const first = reduce(
      session(),
      { type: "TOUCH", surface: "mobile", at: at(60_000).toISOString() },
      { now: at(60_000), live: quote() },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next.surfacesSeen).toEqual(["web", "mobile"]);

    const again = reduce(
      first.next,
      { type: "TOUCH", surface: "mobile", at: at(70_000).toISOString() },
      { now: at(70_000), live: quote() },
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.next.surfacesSeen).toEqual(["web", "mobile"]);
  });

  it("is permitted on a terminal session and does not revive it", () => {
    // This is what lets a scanned link into a dead checkout show a recovery
    // screen instead of a 404, and lets us count that it happened.
    const result = reduce(
      session({ status: "expired" }),
      { type: "TOUCH", surface: "mobile", at: at(60_000).toISOString() },
      { now: at(60_000), live: quote() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("expired");
      expect(result.next.surfacesSeen).toContain("mobile");
      expect(result.emit).toEqual([]);
    }
  });
});
