/**
 * Shared with both surfaces so a countdown rendered on the client can never
 * disagree with the TTL the server enforces. The reasoning behind the two
 * completion timings is in the README.
 */

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const SESSION_EXTENSION_MS = 5 * 60 * 1000;
export const MAX_EXTENSIONS = 1;

/** How long a completion attempt may take once it holds the lock. */
export const COMPLETION_WINDOW_MS = 90 * 1000;

/** Slack for a submit already in flight when the clock struck. Never visible. */
export const COMPLETION_GRACE_MS = 2 * 1000;

/** How long a finished checkout stays readable, so a late retry is not a 404. */
export const TERMINAL_RETENTION_MS = 15 * 60 * 1000;

/** Stripe's window, and for the same reason: a retry a day later is still a retry. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Below this, the countdown escalates to a warning treatment. */
export const EXPIRY_WARNING_MS = 60 * 1000;

export const EXPIRY_SWEEP_INTERVAL_MS = 1_000;

/** Used only when the SSE stream is unavailable. */
export const POLL_FALLBACK_INTERVAL_MS = 3_000;
