"use client";

import { useSearchParams } from "next/navigation";

const MESSAGE: Record<string, string> = {
  INVENTORY_UNAVAILABLE: "Those tickets are no longer available. Try another listing.",
};

const FALLBACK = "We couldn't start that checkout. Try again.";

/**
 * Reads `?error=` in the browser so the page itself does not have to.
 *
 * Reading `searchParams` in a Server Component would opt the entire route out
 * of caching — a steep price for a banner that only appears after a failed
 * checkout. The tradeoff is that it shows up once the page loads rather than
 * in the initial HTML.
 */
export function CheckoutError() {
  const code = useSearchParams().get("error");
  if (!code) return null;

  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
    >
      {MESSAGE[code] ?? FALLBACK}
    </div>
  );
}
