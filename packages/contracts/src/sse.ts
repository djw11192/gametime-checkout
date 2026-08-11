import { z } from "zod";
import type { CheckoutSessionView } from "./session";

/**
 * Server-Sent Events (SSE) rather than WebSockets. Updates only ever flow from
 * server to client, so we do not need a two-way protocol; SSE is plain HTTP,
 * and the browser's built-in `EventSource` handles reconnecting and asking for
 * missed events for free.
 */
export const SseEventTypeSchema = z.enum([
  "session.updated",
  "session.expired",
  "quote.changed",
  "completion.started",
  "completion.succeeded",
  "completion.failed",
]);
export type SseEventType = z.infer<typeof SseEventTypeSchema>;

/**
 * Every message carries the whole view, not just what changed. Sending the full
 * state means applying the same message twice is harmless, and (with the
 * ordering rule in `mergeSessionView`) applying them out of order is too.
 * Sending only the changes would require every message to arrive exactly once,
 * which SSE cannot promise.
 */
export interface SseEnvelope {
  /** Only ever increases, per session. The browser sends it back as `Last-Event-ID`. */
  id: number;
  type: SseEventType;
  view: CheckoutSessionView;
}

/**
 * Merge a pushed view into what the client already has, keeping whichever is
 * newer. Needed because after a reconnect the server deliberately re-sends
 * events the client may have already applied.
 *
 * "Newer" is decided by two values, in this order:
 *
 *   1. `session.version` — bumped every time the stored session is written, so
 *      it orders real changes to the checkout.
 *   2. `serverTime` — breaks ties when the version has not moved. A price
 *      change is exactly that case: the listing moved, the fan's session did
 *      not, so nothing was written and the version is unchanged.
 *
 * Both are needed. Version alone throws away every price change, because they
 * all arrive at the same version. Time alone lets a slow message overwrite a
 * newer checkout state that arrived ahead of it.
 *
 * This assumes one server. Across several, `serverTime` would be a different
 * machine's clock each time, and the tiebreak would need a real sequence number
 * instead of a timestamp.
 */
export function mergeSessionView<
  T extends { session: { version: number }; serverTime: string },
>(cached: T | undefined, incoming: T): T {
  if (!cached) return incoming;
  if (incoming.session.version !== cached.session.version) {
    return incoming.session.version > cached.session.version ? incoming : cached;
  }
  // `toISOString()` always produces the same-width UTC string, so comparing
  // these as text sorts them in time order.
  return incoming.serverTime > cached.serverTime ? incoming : cached;
}

/** Capped, because an unbounded array per session is a memory leak. */
export const SSE_BUFFER_SIZE = 50;
export const SSE_RETRY_MS = 3_000;
/** How often to send a do-nothing message, so proxies do not close an idle connection. */
export const SSE_HEARTBEAT_MS = 15_000;
