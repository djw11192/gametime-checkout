import { z } from "zod";
import type { CheckoutSessionView } from "./session";

/**
 * SSE rather than WebSockets: the traffic is purely server→client, it rides
 * plain HTTP with no upgrade path or sticky-session infrastructure, and
 * `EventSource` gives reconnection and `Last-Event-ID` replay for free — which
 * is the "the fan got interrupted and came back" problem this whole prototype
 * is about, expressed at the transport layer.
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
 * Every payload carries the full view rather than a patch. Full-state pushes
 * are idempotent and order-insensitive when paired with the staleness guard
 * below; a patch protocol would need exactly-once delivery, which SSE does not
 * offer.
 */
export interface SseEnvelope {
  /** Monotonic per session. Echoed back by the browser as `Last-Event-ID`. */
  id: number;
  type: SseEventType;
  view: CheckoutSessionView;
}

/**
 * Fold a pushed view into what the client already has, dropping anything not
 * strictly newer.
 *
 * Reconnect replay deliberately re-sends events the client may already have
 * processed. Without a guard a replayed envelope can walk a completed checkout
 * back to `active` — the fan watches their confirmation turn back into a buy
 * button.
 *
 * **Newer is two clocks, in this order.** `session.version` orders *mutations*:
 * it is the optimistic-concurrency token and only advances when the stored
 * session is written. `serverTime` orders *re-projections at the same version*,
 * and that is precisely what a price change is — the marketplace moved, the
 * fan's agreement did not, so the session is byte-identical and only
 * `liveQuote`, `drift`, `blockers` and `canComplete` differ.
 *
 * Comparing version alone silently discards every `quote.changed` push, which
 * is the one event the whole feature exists to deliver. Comparing time alone
 * would let a replayed projection outrank a real mutation. It has to be the
 * pair.
 *
 * Single-writer assumption: `serverTime` is stamped by one process's clock
 * (`buildView`). Across instances this wants a real sequence — a Redis stream
 * id — rather than a timestamp.
 */
export function mergeSessionView<
  T extends { session: { version: number }; serverTime: string },
>(cached: T | undefined, incoming: T): T {
  if (!cached) return incoming;
  if (incoming.session.version !== cached.session.version) {
    return incoming.session.version > cached.session.version ? incoming : cached;
  }
  // ISO-8601 UTC from `toISOString()` — fixed width, so lexicographic ordering
  // is chronological ordering.
  return incoming.serverTime > cached.serverTime ? incoming : cached;
}

/** Bounded, because an unbounded per-session array is a memory leak. */
export const SSE_BUFFER_SIZE = 50;
export const SSE_RETRY_MS = 3_000;
/** Comment-frame keepalive; defeats intermediary idle timeouts. */
export const SSE_HEARTBEAT_MS = 15_000;
