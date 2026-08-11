import {
  isTerminal,
  type BlockerCode,
  type CheckoutSession,
  type CheckoutSessionView,
  type Drift,
  type Listing,
  type Quote,
} from "@gametime/contracts";
import { effectiveStatus } from "./checkout-machine";

/**
 * Combines the stored session with the listing's current state to build what
 * every endpoint returns.
 *
 * Nothing worked out here is written back to the session. Drift is a
 * comparison against right now, so storing it would mean showing a "the price
 * went up" banner for a price that has since come back down.
 */
export function buildView(input: {
  session: CheckoutSession;
  listing: Listing | null;
  liveQuote: Quote | null;
  now: Date;
}): CheckoutSessionView {
  const { session, listing, liveQuote, now } = input;
  const status = effectiveStatus(session, now);
  const drift = computeDrift(session, listing, liveQuote);
  const blockers = computeBlockers(session, status, drift, liveQuote);

  return {
    // Report the status the session actually has right now, so a client
    // rendering straight from this payload can never show a running countdown
    // on a checkout whose time is up.
    session: { ...session, status },
    liveQuote,
    drift,
    remainingMs: Math.max(0, new Date(session.expiresAt).getTime() - now.getTime()),
    serverTime: now.toISOString(),
    canComplete: blockers.length === 0,
    blockers,
  };
}

function computeDrift(
  session: CheckoutSession,
  listing: Listing | null,
  liveQuote: Quote | null,
): Drift[] {
  // Once the charge is in flight the amount is pinned to `acceptedQuote`, so a
  // later price move cannot reach the fan and there is nothing for them to act
  // on. The same holds after the order exists. Telling them either way is noise.
  if (session.status === "completing" || isTerminal(session.status)) return [];
  if (!listing || !liveQuote || listing.availableQuantity <= 0) {
    return [{ type: "inventory_unavailable" }];
  }

  const drift: Drift[] = [];

  if (listing.availableQuantity < session.quantity) {
    drift.push({
      type: "quantity_reduced",
      availableQuantity: listing.availableQuantity,
      requestedQuantity: session.quantity,
    });
  }

  // Compared against the price the fan last accepted, not the one the session
  // started with. Once they accept an increase, that becomes the new baseline;
  // otherwise the banner keeps reporting a change they already agreed to.
  if (liveQuote.hash !== session.acknowledgedQuoteHash) {
    const delta = liveQuote.totalCents - session.acceptedQuote.totalCents;
    if (delta !== 0) {
      drift.push({
        type: delta > 0 ? "price_increased" : "price_decreased",
        deltaCents: Math.abs(delta),
        fromCents: session.acceptedQuote.totalCents,
        toCents: liveQuote.totalCents,
      });
    }
  }

  return drift;
}

function computeBlockers(
  session: CheckoutSession,
  status: ReturnType<typeof effectiveStatus>,
  drift: Drift[],
  liveQuote: Quote | null,
): BlockerCode[] {
  const blockers: BlockerCode[] = [];

  if (status === "expired") blockers.push("session_expired");
  else if (isTerminal(status)) blockers.push("session_terminal");
  if (status === "completing") blockers.push("completion_in_progress");

  if (drift.some((d) => d.type === "inventory_unavailable" || d.type === "quantity_reduced")) {
    blockers.push("inventory_unavailable");
  }

  // The display side of the rule enforced in BEGIN_COMPLETION. The button and
  // the API have to agree on when buying is allowed, so the fan is never shown
  // an enabled button that would be refused.
  if (
    !isTerminal(status) &&
    status !== "completing" &&
    liveQuote &&
    session.acknowledgedQuoteHash !== liveQuote.hash
  ) {
    blockers.push("quote_unacknowledged");
  }

  return blockers;
}
