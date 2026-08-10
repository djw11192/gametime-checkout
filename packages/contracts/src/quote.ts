import { z } from "zod";

/**
 * A priced offer for a listing at a quantity.
 *
 * `hash` is the important field: a digest over exactly the numbers a fan would
 * notice changing, behaving like an ETag for price. Every request that could
 * result in a charge carries the hash of the quote the fan was actually looking
 * at, so the server can refuse rather than charge a price nobody saw.
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

/** The canonical string the hash is computed over — one definition of "the price changed". */
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
