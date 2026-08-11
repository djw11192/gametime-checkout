/**
 * Shared by the API and both surfaces, so a countdown drawn in the browser can
 * never disagree with the deadline the server actually enforces. The reasoning
 * behind the two completion timings is in the README.
 */

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const SESSION_EXTENSION_MS = 5 * 60 * 1000;
export const MAX_EXTENSIONS = 1;

/** How long a completion attempt may take once it holds the lock. */
export const COMPLETION_WINDOW_MS = 90 * 1000;

/**
 * Extra time allowed for a purchase that was already submitted when the clock
 * ran out. Never shown to the fan — see `hasElapsed`.
 */
export const COMPLETION_GRACE_MS = 2 * 1000;

/** How long a finished checkout is still readable, so a late retry is not a 404. */
export const TERMINAL_RETENTION_MS = 15 * 60 * 1000;

/** Matches Stripe, for the same reason: a retry a day later is still a retry. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Below this, the countdown switches to its warning style. */
export const EXPIRY_WARNING_MS = 60 * 1000;

/** How often the server checks for sessions that have run out of time. */
export const EXPIRY_SWEEP_INTERVAL_MS = 1_000;

/** Used only when the live update stream is unavailable. */
export const POLL_FALLBACK_INTERVAL_MS = 3_000;

/**
 * The listing `/demo` always checks out. Shared so the API can grant it
 * unlimited stock (see `InMemoryInventoryProvider`) without the two ends
 * drifting on which listing that is.
 */
export const DEMO_LISTING_ID = "lst_warriors_lower_112";
