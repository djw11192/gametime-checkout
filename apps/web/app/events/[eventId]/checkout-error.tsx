"use client";

import { useSearchParams } from "next/navigation";

const MESSAGE: Record<string, string> = {
  INVENTORY_UNAVAILABLE: "Those tickets are no longer available. Try another listing.",
};

const FALLBACK = "We couldn't start that checkout. Try again.";

/**
 * Reads `?error=` on the client so the page does not have to. Touching
 * `searchParams` in a Server Component opts the whole route out of caching, for
 * a banner that only appears after a failed checkout attempt — the trade is that
 * it arrives at hydration rather than in the HTML.
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
