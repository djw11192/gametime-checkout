import { describe, expect, it } from "vitest";
import {
  CheckoutSessionViewSchema,
  mergeSessionView,
  type CheckoutSessionView,
} from "@gametime/contracts";

/**
 * The fold the SSE handler runs.
 *
 * `useCheckoutSession` does exactly one stateful thing: for every frame that
 * arrives, replace the cached view if the frame is newer. Everything the fan
 * sees change without reloading — the drift banner, the disabled buy button,
 * "completing on your other device" — is downstream of that one decision, so
 * it is worth testing on its own, without a DOM.
 *
 * Fixtures go through the real schema rather than being cast, so a contract
 * change fails here instead of silently making the tests fictional.
 */

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (secondsAfterT0: number) => new Date(T0 + secondsAfterT0 * 1000).toISOString();

const QUANTITY = 2;
const FEE_RATE = 0.15;

/** Money is integer cents everywhere, including in fixtures — the schema enforces it. */
function quote(pricePerTicketCents: number, hash: string) {
  const feesPerTicketCents = Math.round(pricePerTicketCents * FEE_RATE);
  return {
    listingId: "lst_warriors_lower_112",
    quantity: QUANTITY,
    pricePerTicketCents,
    feesPerTicketCents,
    subtotalCents: pricePerTicketCents * QUANTITY,
    feesCents: feesPerTicketCents * QUANTITY,
    totalCents: (pricePerTicketCents + feesPerTicketCents) * QUANTITY,
    hash,
  };
}

const BASE_PRICE = 23_000;
const RAISED_PRICE = 24_000;
const totalOf = (pricePerTicketCents: number) =>
  (pricePerTicketCents + Math.round(pricePerTicketCents * FEE_RATE)) * QUANTITY;

/** A live checkout as the server projects it: agreement, reality, verdict. */
function view(overrides: {
  version: number;
  serverTime: string;
  livePrice?: number;
  liveHash?: string;
  drift?: CheckoutSessionView["drift"];
  blockers?: CheckoutSessionView["blockers"];
  status?: CheckoutSessionView["session"]["status"];
}): CheckoutSessionView {
  const accepted = quote(BASE_PRICE, "hash_a");
  const liveHash = overrides.liveHash ?? "hash_a";

  return CheckoutSessionViewSchema.parse({
    session: {
      id: "sess_1",
      version: overrides.version,
      status: overrides.status ?? "active",
      eventId: "evt_warriors_lakers",
      listingId: accepted.listingId,
      quantity: 2,
      acceptedQuote: accepted,
      acknowledgedQuoteHash: "hash_a",
      expiresAt: at(600),
      extensionsUsed: 0,
      origin: { surface: "web", at: at(0) },
      lastSeen: { surface: "web", at: at(0) },
      surfacesSeen: ["web"],
      completion: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
    liveQuote: quote(overrides.livePrice ?? BASE_PRICE, liveHash),
    drift: overrides.drift ?? [],
    remainingMs: 540_000,
    serverTime: overrides.serverTime,
    canComplete: (overrides.blockers ?? []).length === 0,
    blockers: overrides.blockers ?? [],
  });
}

/** What the hook does per frame, minus React. */
const fold = (frames: CheckoutSessionView[], initial: CheckoutSessionView) =>
  frames.reduce<CheckoutSessionView>((cached, incoming) => mergeSessionView(cached, incoming), initial);

describe("folding pushed views into the cached one", () => {
  /**
   * A price change is not a session mutation — the fan's agreement is untouched,
   * so `session.version` does not move — but `drift`, `blockers` and
   * `canComplete` all do. Ordering purely on version discards every
   * `quote.changed` frame: the API is correct, the push arrives, and the client
   * throws it away.
   */
  it("applies a price change that arrives at an unchanged session version", () => {
    const onScreen = view({ version: 3, serverTime: at(10) });

    const repriced = view({
      version: 3,
      serverTime: at(40),
      livePrice: RAISED_PRICE,
      liveHash: "hash_b",
      drift: [
        {
          type: "price_increased",
          deltaCents: totalOf(RAISED_PRICE) - totalOf(BASE_PRICE),
          fromCents: totalOf(BASE_PRICE),
          toCents: totalOf(RAISED_PRICE),
        },
      ],
      blockers: ["quote_unacknowledged"],
    });

    const merged = mergeSessionView(onScreen, repriced);

    expect(merged.canComplete).toBe(false);
    expect(merged.blockers).toEqual(["quote_unacknowledged"]);
    expect(merged.drift[0]).toMatchObject({
      type: "price_increased",
      toCents: totalOf(RAISED_PRICE),
    });
    expect(merged.liveQuote?.hash).toBe("hash_b");
  });

  it("applies a sell-out that arrives at an unchanged session version", () => {
    const merged = mergeSessionView(
      view({ version: 3, serverTime: at(10) }),
      view({
        version: 3,
        serverTime: at(40),
        drift: [{ type: "inventory_unavailable" }],
        blockers: ["inventory_unavailable"],
      }),
    );

    expect(merged.canComplete).toBe(false);
    expect(merged.drift).toEqual([{ type: "inventory_unavailable" }]);
  });

  /**
   * The guard the ordering exists for. `EventSource` replays from
   * `Last-Event-ID` on reconnect, so the client re-receives frames it already
   * applied. Without ordering, a replayed `active` frame walks a completed
   * checkout backwards and the fan's confirmation turns back into a buy button.
   */
  it("never walks a completed checkout back to active on reconnect replay", () => {
    const completed = view({
      version: 9,
      serverTime: at(120),
      status: "completed",
      blockers: ["session_terminal"],
    });

    const replayed = [
      view({ version: 3, serverTime: at(10) }),
      view({ version: 4, serverTime: at(20) }),
      view({ version: 9, serverTime: at(120), status: "completed", blockers: ["session_terminal"] }),
    ];

    expect(fold(replayed, completed).session.status).toBe("completed");
  });

  it("is idempotent: replaying a batch twice lands on the same view", () => {
    const initial = view({ version: 1, serverTime: at(1) });
    const batch = [
      view({ version: 1, serverTime: at(5), drift: [{ type: "inventory_unavailable" }] }),
      view({ version: 2, serverTime: at(9) }),
    ];

    const once = fold(batch, initial);
    const twice = fold(batch, once);

    expect(twice).toEqual(once);
  });

  it("prefers a real mutation over a later projection of the older state", () => {
    const merged = mergeSessionView(
      view({ version: 4, serverTime: at(99) }),
      view({ version: 5, serverTime: at(1) }),
    );
    expect(merged.session.version).toBe(5);
  });
});
