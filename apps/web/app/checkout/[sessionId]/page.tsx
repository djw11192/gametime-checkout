import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatEventDate } from "@gametime/contracts";
import { CheckoutPanel } from "@/components/checkout/checkout-panel";
import { Handoff } from "@/components/checkout/handoff";
import { DeliveryEstimate, DeliveryEstimateSkeleton } from "@/components/checkout/delivery-estimate";
import { Card } from "@/components/ui";
import { ApiClientError, getCheckoutSession, getEventWithListings, getListing } from "@/lib/api";
import { clientContext } from "@/lib/surface";

/**
 * Renders the complete checkout summary into the initial HTML: event, seats,
 * itemised price, drift banner, and a countdown already showing a real number.
 * No client-side fetch on first load.
 *
 * `force-dynamic` because serving an `expiresAt` from a cache is worse than
 * serving nothing.
 */
export const dynamic = "force-dynamic";

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

  // Issued together: awaiting in sequence would add a round trip to the
  // critical path for no benefit.
  const [eventData, listing] = await Promise.all([
    getEventWithListings(view.session.eventId),
    getListing(view.session.listingId).catch(() => null),
  ]);

  const headerList = await headers();
  const origin = `${headerList.get("x-forwarded-proto") ?? "http"}://${headerList.get("host")}`;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <Link
        href={`/events/${view.session.eventId}`}
        className="text-sm text-slate-500 hover:underline"
      >
        ← Back to tickets
      </Link>

      <Card className="mt-4 p-6">
        <header className="border-b border-slate-200 pb-4 dark:border-slate-800">
          <h1 className="text-xl font-bold tracking-tight">{eventData.event.name}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {formatEventDate(eventData.event.startsAt)} · {eventData.event.venueName}
          </p>
          {listing ? (
            <p className="mt-2 text-sm font-medium">
              Section {listing.section} · Row {listing.row} · {view.session.quantity} ticket
              {view.session.quantity > 1 ? "s" : ""}
            </p>
          ) : null}
        </header>

        <div className="pt-5">
          <CheckoutPanel
            initialView={view}
            event={eventData.event}
            clientId={context.clientId}
            // Minted per server render, so a double-click posts one key and a
            // retry after a decline gets a fresh one.
            idempotencyKey={randomUUID()}
          />
        </div>
      </Card>

      {/* Secondary content streams in behind a Suspense boundary with a
          fixed-height skeleton: the shell paints without waiting on the slowest
          thing in the tree, and nothing moves when it resolves. */}
      <div className="mt-4">
        <Suspense fallback={<DeliveryEstimateSkeleton />}>
          <DeliveryEstimate listing={listing} />
        </Suspense>
      </div>

      <div className="mt-4">
        <Handoff sessionId={sessionId} origin={origin} />
      </div>
    </main>
  );
}
