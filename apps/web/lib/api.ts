import "server-only";
import {
  ApiErrorBodySchema,
  CheckoutSessionViewSchema,
  EventListResponseSchema,
  EventWithListingsSchema,
  ListingSchema,
  OrderSchema,
  type ApiErrorCode,
  type CheckoutSessionView,
  type EventWithListings,
  type Order,
  type Surface,
} from "@gametime/contracts";

/**
 * Server-side client for the checkout API. `server-only` makes importing this
 * from a Client Component a build error rather than a subtle regression:
 * everything here runs during SSR against an internal address, so the browser
 * never makes the first request. Browser-side calls go same-origin through the
 * rewrite in `next.config.ts`.
 */

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable: boolean,
    /** The API attaches the current view to conflicts so callers can reconcile. */
    readonly session?: CheckoutSessionView,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  parse: (data: unknown) => T,
  init?: RequestInit & { idempotencyKey?: string; revalidate?: number },
): Promise<T> {
  const { revalidate, idempotencyKey, ...requestInit } = init ?? {};

  const headers = new Headers();
  if (requestInit.body) headers.set("content-type", "application/json");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

  // Uncached by default, because checkout state is never cacheable: an
  // `expiresAt` served from a cache is worse than no data at all. Catalog reads
  // opt in explicitly — see `CATALOG_REVALIDATE_SECONDS`.
  const caching =
    revalidate === undefined ? { cache: "no-store" as const } : { next: { revalidate } };

  const response = await fetch(`${API_BASE}${path}`, { ...requestInit, headers, ...caching });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = ApiErrorBodySchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiClientError("INTERNAL_ERROR", `Request failed (${response.status})`, true);
    }
    const session = CheckoutSessionViewSchema.safeParse(parsed.data.session);
    throw new ApiClientError(
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.retryable,
      session.success ? session.data : undefined,
    );
  }

  return parse(payload);
}

const parseSession = (data: unknown) =>
  CheckoutSessionViewSchema.parse((data as { session: unknown }).session);

/* ── Catalog ──────────────────────────────────────────────────────────────── */

/**
 * Browsing is the same for every fan, so it is cached rather than re-rendered
 * per visitor. A stale price here is not a correctness problem: the price a fan
 * is held to is the one quoted when the session is created, and the quote hash
 * catches any move before they are charged.
 */
const EVENT_LIST_REVALIDATE_SECONDS = 60;
const EVENT_LISTINGS_REVALIDATE_SECONDS = 30;

/** Names, venues and dates. Barely change, so the longest window in the app. */
export const listEvents = () =>
  call("/api/events", (data) => EventListResponseSchema.parse(data).events, {
    revalidate: EVENT_LIST_REVALIDATE_SECONDS,
  });

/** Shorter, because this one carries prices. */
export const getEventWithListings = (eventId: string): Promise<EventWithListings> =>
  call(`/api/events/${eventId}`, (data) => EventWithListingsSchema.parse(data), {
    revalidate: EVENT_LISTINGS_REVALIDATE_SECONDS,
  });

/**
 * Uncached, unlike the two above: this is called on the checkout path, where a
 * listing's availability feeds the decision to sell.
 *
 * By id rather than from the event list, which omits sold-out listings.
 */
export const getListing = (listingId: string) =>
  call(`/api/listings/${listingId}`, (data) =>
    ListingSchema.parse((data as { listing: unknown }).listing),
  );

/* ── Checkout ─────────────────────────────────────────────────────────────── */

export const createCheckoutSession = (input: {
  listingId: string;
  quantity: number;
  surface: Surface;
  clientId: string;
}) => call("/api/checkout/sessions", parseSession, { method: "POST", body: JSON.stringify(input) });

export function getCheckoutSession(
  sessionId: string,
  context?: { surface: Surface; clientId: string; viaDeepLink?: boolean },
) {
  const query = context
    ? `?surface=${context.surface}&clientId=${encodeURIComponent(context.clientId)}${
        context.viaDeepLink ? "&src=deeplink" : ""
      }`
    : "";
  return call(`/api/checkout/sessions/${sessionId}${query}`, parseSession);
}

export const acknowledgeQuote = (
  sessionId: string,
  input: { quoteHash: string; surface: Surface; clientId: string },
) =>
  call(`/api/checkout/sessions/${sessionId}/acknowledge`, parseSession, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const extendSession = (
  sessionId: string,
  input: { surface: Surface; clientId: string },
) =>
  call(`/api/checkout/sessions/${sessionId}/extend`, parseSession, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const completeCheckout = (
  sessionId: string,
  input: { quoteHash: string; surface: Surface; clientId: string },
  idempotencyKey: string,
): Promise<{ session: CheckoutSessionView; order: Order | null }> =>
  call(
    `/api/checkout/sessions/${sessionId}/complete`,
    (data) => {
      const body = data as { session: unknown; order: unknown };
      return {
        session: CheckoutSessionViewSchema.parse(body.session),
        order: body.order ? OrderSchema.parse(body.order) : null,
      };
    },
    { method: "POST", body: JSON.stringify(input), idempotencyKey },
  );
