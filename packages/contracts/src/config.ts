/**
 * Shared with both surfaces so a countdown rendered on the client can never
 * disagree with the TTL the server enforces.
 */

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const SESSION_EXTENSION_MS = 5 * 60 * 1000;
export const MAX_EXTENSIONS = 1;

/**
 * How long a completion attempt may take once it holds the lock.
 *
 * Taking the lock changes what the deadline means. Until then it is "how long
 * may you shop", and expiring is correct — the fan wandered off. After it, the
 * fan has committed and we are talking to a payment processor, so the remaining
 * time is ours, not theirs. Letting the original TTL run out mid-authorization
 * expires a checkout because *our* round-trip was slow, and a card declined at
 * 10:01 on a 10:00 deadline would send the fan back to the start rather than
 * letting them try another card.
 */
export const COMPLETION_WINDOW_MS = 90 * 1000;

/**
 * Slack for a submit that was already in flight when the clock struck.
 *
 * "Submitted before the deadline" and "evaluated before the deadline" are not
 * the same instant: there is network latency, TLS, and server queueing in
 * between. Refusing a purchase because those took 40ms punishes the fan for our
 * transit time.
 *
 * Deliberately invisible. It is not extra shopping time — the countdown still
 * reads 0:00 at `expiresAt`, the view still reports `expired`, and the button
 * still goes dead. Only a completion request already on the wire benefits.
 */
export const COMPLETION_GRACE_MS = 2 * 1000;

/**
 * How long a finished checkout sticks around before it is deleted.
 *
 * Not zero, which is the tempting answer. A completed session is what turns a
 * late retry into "here is your order" instead of a 404, and it is what the
 * fan's other device loads to render the confirmation. Stripe keeps expired
 * Checkout Sessions retrievable for 30 days for the same reasons; this is the
 * same idea at prototype scale. Against Redis this is not a scan at all — it is
 * `EXPIRE` on the key at the moment the session goes terminal.
 */
export const TERMINAL_RETENTION_MS = 15 * 60 * 1000;

/** Stripe's window, and for the same reason: a retry a day later is still a retry. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Below this, the countdown escalates to a warning treatment. */
export const EXPIRY_WARNING_MS = 60 * 1000;

export const EXPIRY_SWEEP_INTERVAL_MS = 1_000;

/** Used only when the SSE stream is unavailable. */
export const POLL_FALLBACK_INTERVAL_MS = 3_000;
