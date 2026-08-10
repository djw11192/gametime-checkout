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
 * Projects a stored session plus current marketplace reality into the shape
 * every endpoint returns. Nothing computed here is written back — drift is a
 * comparison, and persisting comparisons is how you end up serving a "price
 * went up!" banner for a price that has since gone back down.
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
    // Report the *effective* status, so a client rendering straight from the
    // payload can never show a live countdown on a session that has run out.
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
  // Once an order exists the charged price is the charged price; telling
  // someone the listing has since got cheaper is not actionable.
  if (isTerminal(session.status)) return [];
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

  // Compared against what the fan *acknowledged*, not what the session was
  // created with: once someone accepts a rise that becomes the new baseline,
  // otherwise the banner keeps shouting about a delta they already agreed to.
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

  // The UI half of the rule enforced in BEGIN_COMPLETION: the button and the
  // API agree on when a purchase is allowed, so the fan never gets to click
  // something that will 409.
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
