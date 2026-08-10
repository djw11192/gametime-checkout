import { describe, expect, it } from "vitest";
import {
  COMPLETION_GRACE_MS,
  COMPLETION_WINDOW_MS,
  MAX_EXTENSIONS,
  SESSION_EXTENSION_MS,
  SESSION_TTL_MS,
  type CheckoutSession,
  type Quote,
  type SessionStatus,
} from "@gametime/contracts";
import { createSession, effectiveStatus, reduce, type Command } from "./checkout-machine";

/**
 * The state machine is a pure function, so these tests need no server, no
 * store, and — critically — no sleeping. A ten-minute TTL is exercised by
 * handing `reduce` a different `now`.
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
    // Starting checkout *is* seeing and accepting the current price, so there is
    // no drift banner on the very first render.
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

  it("leaves terminal states alone once the clock passes their deadline", () => {
    const completed = session({ status: "completed" });
    expect(effectiveStatus(completed, at(SESSION_TTL_MS * 5))).toBe("completed");
  });
});

describe("the transition table", () => {
  /**
   * Every (status, command) pair, asserted in one place. When someone adds a
   * status later, the gaps in this table are where the bugs would have been.
   */
  const cases: Array<{
    from: SessionStatus;
    command: Command;
    expect: { ok: true; to: SessionStatus } | { ok: false; code: string };
  }> = [
    // ── from active ────────────────────────────────────────────────────────
    { from: "active", command: beginCompletion(), expect: { ok: true, to: "completing" } },
    { from: "active", command: { type: "CANCEL" }, expect: { ok: true, to: "canceled" } },
    { from: "active", command: { type: "EXPIRE" }, expect: { ok: true, to: "expired" } },
    { from: "active", command: { type: "EXTEND" }, expect: { ok: true, to: "active" } },

    // ── from completing: the single-flight guard ───────────────────────────
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

    // ── terminal states reject everything ──────────────────────────────────
    ...(["completed", "canceled", "failed"] as const).flatMap((from) => [
      { from, command: beginCompletion(), expect: { ok: false as const, code: "SESSION_TERMINAL" } },
      { from, command: { type: "CANCEL" as const }, expect: { ok: false as const, code: "SESSION_TERMINAL" } },
      { from, command: { type: "EXTEND" as const }, expect: { ok: false as const, code: "SESSION_TERMINAL" } },
    ]),

    // `expired` is terminal too, but always reports itself specifically: it is
    // the one dead state the fan can do something about, so the client has to
    // be able to tell it apart from "this order already happened".
    ...([beginCompletion(), { type: "CANCEL" as const }, { type: "EXTEND" as const }]).map(
      (command) => ({
        from: "expired" as const,
        command,
        expect: { ok: false as const, code: "SESSION_EXPIRED" },
      }),
    ),
  ];

  for (const testCase of cases) {
    const label = `${testCase.from} + ${testCase.command.type}`;
    it(
      testCase.expect.ok
        ? `${label} → ${testCase.expect.to}`
        : `${label} → rejected (${testCase.expect.code})`,
      () => {
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

        if (testCase.expect.ok) {
          expect(result.ok, JSON.stringify(result)).toBe(true);
          if (result.ok) expect(result.next.status).toBe(testCase.expect.to);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.code).toBe(testCase.expect.code);
        }
      },
    );
  }

  it("rejects an expired-but-unswept session as SESSION_EXPIRED, not SESSION_TERMINAL", () => {
    // The distinction matters to the client: expired is recoverable by starting
    // a new checkout on the same seats; terminal generally is not.
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
  it("honours a purchase that lands just past the deadline", () => {
    // The fan pressed the button before 0:00. What happened next was network,
    // TLS and queueing — our latency, not their hesitation. Refusing here would
    // punish them for the round-trip.
    const result = reduce(session(), beginCompletion(), {
      now: at(SESSION_TTL_MS + COMPLETION_GRACE_MS - 1),
      live: quote(),
    });
    expect(result.ok).toBe(true);
  });

  it("gives only completion the benefit of the doubt", () => {
    // Extending or cancelling inside the grace is not a request that was
    // already in flight against a live deadline; it is a fan acting on a dead
    // screen. Only the purchase gets the slack.
    const now = at(SESSION_TTL_MS + COMPLETION_GRACE_MS - 1);
    for (const command of [{ type: "EXTEND" } as const, { type: "CANCEL" } as const]) {
      const result = reduce(session(), command, { now, live: quote() });
      expect(result.ok, command.type).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("SESSION_EXPIRED");
    }
  });

  it("does not let the grace leak into what the fan is shown", () => {
    // The countdown must still read 0:00 at `expiresAt`. The grace is slack for
    // a request already on the wire, not two extra seconds of shopping.
    expect(effectiveStatus(session(), at(SESSION_TTL_MS))).toBe("expired");
  });

  it("hands the attempt its own deadline once it holds the lock", () => {
    // Submitted with four seconds left: the remaining TTL is now irrelevant,
    // because what the clock is measuring changed. It is our authorization
    // round-trip, not their shopping time.
    const started = reduce(session(), beginCompletion(), {
      now: at(SESSION_TTL_MS - 4_000),
      live: quote(),
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(new Date(started.next.expiresAt).getTime() - T0.getTime()).toBe(
      SESSION_TTL_MS - 4_000 + COMPLETION_WINDOW_MS,
    );
    // Not out of the fan's pocket: the one extension they are allowed is still
    // theirs to spend.
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
    // A client could obtain the live hash by re-reading, then complete without
    // ever showing the fan the new price. The server must not allow that: the
    // acknowledgement is a separate, explicit act.
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
    // Without this the purchase authorizes a card and only discovers the
    // shortfall at the inventory commit, leaving a hold on money for tickets
    // that were never going to exist. The view already blocks the button on
    // `quantity_reduced`; this is the API agreeing with it.
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

  it("allows completion when the seller has exactly enough", () => {
    const result = reduce(session(), beginCompletion(), {
      now: at(1_000),
      live: quote(),
      availableQuantity: 2,
    });
    expect(result.ok).toBe(true);
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
    // The case this used to get wrong. The fan submitted with two seconds left;
    // the processor took four to say no. Expiring them here would blame them for
    // our round-trip and make them start over to change cards.
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
    // The window is generous but finite. Handing back a session with 0:00 on the
    // clock and an enabled button would be worse than saying plainly it is over.
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

  it("refuses to settle a session with nothing in flight", () => {
    const result = reduce(
      session(),
      { type: "SETTLE_COMPLETION", result: { kind: "succeeded", orderId: "ord_1" } },
      { now: at(2_000), live: quote() },
    );
    expect(result.ok).toBe(false);
  });
});

describe("extension", () => {
  it("adds time and is capped", () => {
    let current = session();
    for (let i = 0; i < MAX_EXTENSIONS; i++) {
      const result = reduce(current, { type: "EXTEND" }, { now: at(1_000), live: quote() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      current = result.next;
    }

    expect(new Date(current.expiresAt).getTime() - T0.getTime()).toBe(
      SESSION_TTL_MS + SESSION_EXTENSION_MS * MAX_EXTENSIONS,
    );

    const beyond = reduce(current, { type: "EXTEND" }, { now: at(1_000), live: quote() });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.error.code).toBe("EXTENSION_LIMIT_REACHED");
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
    // This is what lets a deep link into a dead checkout render a recovery
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
