"use client";

import { useSearchParams } from "next/navigation";

/**
 * Reads `?error=` on the client so the page itself does not have to.
 *
 * Touching `searchParams` in a Server Component is a dynamic API: it opts the
 * whole route out of caching, for a banner that appears only after a failed
 * checkout attempt. Reading it here keeps the listings cacheable and pays for it
 * with one small client component.
 *
 * The trade is a layout shift on that error path — the banner arrives at
 * hydration rather than in the HTML. Worth it: the error is rare and the browse
 * page is the most requested surface in the app.
 */
export function CheckoutError() {
  const code = useSearchParams().get("error");
  if (!code) return null;

  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
    >
      Those tickets are no longer available. Try another listing.
    </div>
  );
}
