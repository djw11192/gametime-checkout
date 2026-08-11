import { z } from "zod";

/**
 * A price for a listing at a given quantity.
 *
 * `hash` is the field that matters. It is computed over exactly the numbers a
 * fan would notice changing, so comparing two hashes answers "is this still the
 * same price?". Every request that could charge someone carries the hash of the
 * quote they were actually looking at, which lets the server refuse rather than
 * charge a price nobody was shown.
 */
export const QuoteSchema = z.object({
  listingId: z.string(),
  quantity: z.number().int().positive(),
  pricePerTicketCents: z.number().int().nonnegative(),
  feesPerTicketCents: z.number().int().nonnegative(),
  subtotalCents: z.number().int().nonnegative(),
  feesCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  hash: z.string(),
});
export type Quote = z.infer<typeof QuoteSchema>;

/** The exact string the hash is built from: one definition of "the price changed". */
export function quoteFingerprint(input: {
  listingId: string;
  quantity: number;
  pricePerTicketCents: number;
  feesPerTicketCents: number;
}): string {
  return [
    input.listingId,
    input.quantity,
    input.pricePerTicketCents,
    input.feesPerTicketCents,
  ].join(":");
}
