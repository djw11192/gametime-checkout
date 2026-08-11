/**
 * Used by the server render and the browser alike, so both produce exactly the
 * same text. Two separate implementations of "format cents as dollars" is a
 * well-known cause of React hydration errors — the kind that only appear for
 * users in another region.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const USD_PRECISE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

/** `12800` → `"$128"`. */
export const formatCents = (cents: number) => USD.format(Math.round(cents / 100));

/** `12845` → `"$128.45"`, for the itemized breakdown. */
export const formatCentsPrecise = (cents: number) => USD_PRECISE.format(cents / 100);

/** `598000` → `"9:58"`. Clamps at zero; never renders a negative clock. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Pinned to one timezone on purpose. A bare `toLocaleString` would use the
 * server's timezone when rendering and the device's when hydrating, which is a
 * guaranteed mismatch for anyone outside the server's region.
 */
const TZ = "America/Los_Angeles";

export const formatClockTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }).format(
    new Date(iso),
  );

export const formatEventDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  }).format(new Date(iso));
