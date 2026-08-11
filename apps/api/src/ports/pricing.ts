import { createHash } from "node:crypto";
import { quoteFingerprint, type Listing, type Quote } from "@gametime/contracts";

/**
 * Kept separate from inventory because the two change independently: the seller
 * sets the ticket price, while we set fees and promotions.
 */
export type QuoteListing = (listing: Listing, quantity: number) => Quote;

/** Truncated sha256 — a change detector, not a security boundary. */
function hashQuote(input: {
  listingId: string;
  quantity: number;
  pricePerTicketCents: number;
  feesPerTicketCents: number;
}): string {
  return createHash("sha256").update(quoteFingerprint(input)).digest("hex").slice(0, 16);
}

export const quoteFromListing: QuoteListing = (listing, quantity) => {
  const subtotalCents = listing.pricePerTicketCents * quantity;
  const feesCents = listing.feesPerTicketCents * quantity;

  return {
    listingId: listing.id,
    quantity,
    pricePerTicketCents: listing.pricePerTicketCents,
    feesPerTicketCents: listing.feesPerTicketCents,
    subtotalCents,
    feesCents,
    totalCents: subtotalCents + feesCents,
    hash: hashQuote({
      listingId: listing.id,
      quantity,
      pricePerTicketCents: listing.pricePerTicketCents,
      feesPerTicketCents: listing.feesPerTicketCents,
    }),
  };
};
