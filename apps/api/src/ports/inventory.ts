import type { EventRecord, Listing } from "@gametime/contracts";
import { SEED_EVENTS, SEED_LISTINGS } from "../data/seed";

/**
 * Inventory. There is no way to hold or reserve tickets here — on a resale
 * marketplace the tickets belong to the seller and can sell on another site at
 * any moment; see the README.
 *
 * That is the property this fake exists to preserve: inventory is owned by
 * someone else and changes without telling us, so a listing can lose quantity
 * or disappear entirely between two of our own reads. In production this would
 * call the listings service.
 */
export interface InventoryProvider {
  listEvents(): EventRecord[];
  getEvent(eventId: string): EventRecord | null;
  listListingsForEvent(eventId: string): Listing[];
  getListing(listingId: string): Listing | null;
  /** Returns false when the seller no longer has the quantity. */
  commit(listingId: string, quantity: number): boolean;
}

export class InMemoryInventoryProvider implements InventoryProvider {
  private events = new Map<string, EventRecord>();
  private listings = new Map<string, Listing>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.events = new Map(SEED_EVENTS.map((e) => [e.id, { ...e }]));
    this.listings = new Map(SEED_LISTINGS.map((l) => [l.id, { ...l }]));
  }

  listEvents(): EventRecord[] {
    return [...this.events.values()];
  }

  getEvent(eventId: string): EventRecord | null {
    return this.events.get(eventId) ?? null;
  }

  listListingsForEvent(eventId: string): Listing[] {
    return [...this.listings.values()]
      .filter((l) => l.eventId === eventId && l.availableQuantity > 0)
      .sort((a, b) => a.pricePerTicketCents - b.pricePerTicketCents);
  }

  getListing(listingId: string): Listing | null {
    const found = this.listings.get(listingId);
    return found ? { ...found } : null;
  }

  commit(listingId: string, quantity: number): boolean {
    const listing = this.listings.get(listingId);
    if (!listing || listing.availableQuantity < quantity) return false;
    listing.availableQuantity -= quantity;
    return true;
  }

  /* ── Scenario controls ──────────────────────────────────────────────────── */

  applyPriceDelta(listingId: string, deltaCents: number): Listing | null {
    const listing = this.listings.get(listingId);
    if (!listing) return null;
    listing.pricePerTicketCents = Math.max(0, listing.pricePerTicketCents + deltaCents);
    // Fees are a percentage of the ticket price, so they have to move with it.
    listing.feesPerTicketCents = Math.round(listing.pricePerTicketCents * 0.15);
    return { ...listing };
  }

  setAvailableQuantity(listingId: string, quantity: number): Listing | null {
    const listing = this.listings.get(listingId);
    if (!listing) return null;
    listing.availableQuantity = Math.max(0, quantity);
    return { ...listing };
  }
}
