import { createHash } from "node:crypto";
import { quoteFingerprint, type Listing, type Quote } from "@gametime/contracts";
import type { InventoryProvider } from "./inventory";

/**
 * Pricing is split from inventory because in a real marketplace the seller sets
 * face value but the platform computes fees and promotions, and those move on
 * different clocks.
 */
export interface PricingProvider {
  quoteFromListing(listing: Listing, quantity: number): Quote;
}

/** Truncated sha256 — a change detector, not a security boundary, and it travels in form bodies. */
export function hashQuote(input: {
  listingId: string;
  quantity: number;
  pricePerTicketCents: number;
  feesPerTicketCents: number;
}): string {
  return createHash("sha256").update(quoteFingerprint(input)).digest("hex").slice(0, 16);
}

export class MarketplacePricingProvider implements PricingProvider {
  constructor(private readonly inventory: InventoryProvider) {}

  quoteFromListing(listing: Listing, quantity: number): Quote {
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
  }
}
