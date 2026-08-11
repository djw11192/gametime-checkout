import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatEventDate } from "@gametime/contracts";
import { CheckoutPanel } from "@/components/checkout/checkout-panel";
import { Handoff, HandoffSkeleton } from "@/components/checkout/handoff";
import { DeliveryEstimate, DeliveryEstimateSkeleton } from "@/components/checkout/delivery-estimate";
import { Card, Skeleton } from "@/components/ui";
import { ApiClientError, getCheckoutSession, getEventWithListings, getListing } from "@/lib/api";
import { clientContext } from "@/lib/surface";

/** Never cached: see the note on caching in `lib/api.ts`. */
export const dynamic = "force-dynamic";

/**
 * The session is the only thing on the critical path.
 *
 * What a fan is waiting on here is the total, the clock and the buy button, and
 * all three come out of the session alone. The event name, the seats, the
 * delivery estimate and the QR code are context — each is fetched below its own
 * Suspense boundary so none of them can hold up the summary. Awaiting them here
 * would put two serial round-trips in front of an empty page.
 */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const context = await clientContext("web");

  const view = await getCheckoutSession(sessionId, context).catch((error: unknown) => {
    if (error instanceof ApiClientError && error.code === "SESSION_NOT_FOUND") return null;
    throw error;
  });
  if (!view) notFound();

  const { session } = view;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <Link href={`/events/${session.eventId}`} className="text-sm text-slate-500 hover:underline">
        ← Back to tickets
      </Link>

      <Card className="mt-4 p-6">
        <header className="border-b border-slate-200 pb-4 dark:border-slate-800">
          <Suspense fallback={<EventHeadingSkeleton />}>
            <EventHeading
              eventId={session.eventId}
              listingId={session.listingId}
              quantity={session.quantity}
            />
          </Suspense>
        </header>

        <div className="pt-5">
          <CheckoutPanel
            initialView={view}
            eventName={
              <Suspense fallback={null}>
                <EventName eventId={session.eventId} />
              </Suspense>
            }
            clientId={context.clientId}
            idempotencyKey={randomUUID()}
          />
        </div>
      </Card>

      <div className="mt-4">
        <Suspense fallback={<DeliveryEstimateSkeleton />}>
          <DeliveryEstimate listingId={session.listingId} />
        </Suspense>
      </div>

      <div className="mt-4">
        <Suspense fallback={<HandoffSkeleton />}>
          <Handoff sessionId={sessionId} />
        </Suspense>
      </div>
    </main>
  );
}

/** Which event, which seats. Streamed in behind the summary. */
async function EventHeading({
  eventId,
  listingId,
  quantity,
}: {
  eventId: string;
  listingId: string;
  quantity: number;
}) {
  const [eventData, listing] = await Promise.all([
    getEventWithListings(eventId),
    getListing(listingId).catch(() => null),
  ]);

  return (
    <>
      <h1 className="text-xl font-bold tracking-tight">{eventData.event.name}</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {formatEventDate(eventData.event.startsAt)} · {eventData.event.venueName}
      </p>
      {listing ? (
        <p className="mt-2 text-sm font-medium">
          Section {listing.section} · Row {listing.row} · {quantity} ticket
          {quantity > 1 ? "s" : ""}
        </p>
      ) : null}
    </>
  );
}

function EventHeadingSkeleton() {
  return (
    <div aria-hidden>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="mt-2 h-4 w-1/2" />
      <Skeleton className="mt-2.5 h-4 w-56" />
    </div>
  );
}

/**
 * Just the name, for the confirmation screen. Shares the memoised fetch above,
 * so asking for it twice in one render costs one request.
 */
async function EventName({ eventId }: { eventId: string }) {
  const { event } = await getEventWithListings(eventId);
  return <>{event.shortName}</>;
}
