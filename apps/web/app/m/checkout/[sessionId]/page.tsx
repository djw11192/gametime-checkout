import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { formatClockTime } from "@gametime/contracts";
import { DeviceFrame, StatusBar } from "@/components/checkout/device-frame";
import { MobilePanel } from "@/components/checkout/mobile-panel";
import { buttonClass, Skeleton } from "@/components/ui";
import { ApiClientError, getCheckoutSession, getEventWithListings, getListing } from "@/lib/api";
import { clientContext } from "@/lib/surface";

export const dynamic = "force-dynamic";

/**
 * The mobile surface. Same session, same id, same server render as the desktop
 * page — only the layout differs, and nothing about resuming is special-cased.
 *
 * It also splits its fetching the same way: the session blocks, the event and
 * the seats stream in behind it. That matters more here than on desktop, since
 * this is the surface reached by scanning a code on a phone network.
 *
 * The one thing genuinely specific to mobile is opening cold: a scanned link
 * might be followed hours later, into a checkout that no longer exists. That
 * case gets a real screen instead of a 404.
 */
export default async function MobileCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ src?: string }>;
}) {
  const { sessionId } = await params;
  const { src } = await searchParams;
  const context = await clientContext("mobile", src === "deeplink");

  const view = await getCheckoutSession(sessionId, context).catch((error: unknown) => {
    if (error instanceof ApiClientError && error.code === "SESSION_NOT_FOUND") return null;
    throw error;
  });

  if (!view) {
    return (
      <DeviceFrame>
        <StatusBar label="Gametime" />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <span aria-hidden className="text-3xl">
            🎟️
          </span>
          <div>
            <h1 className="text-base font-semibold">This checkout link has gone</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Links expire once a purchase completes or the hold runs out. Nothing was charged.
            </p>
          </div>
          <Link href="/" className={buttonClass("primary")}>
            Browse tickets
          </Link>
        </div>
      </DeviceFrame>
    );
  }

  const { session } = view;

  return (
    <DeviceFrame>
      <StatusBar label={formatClockTime(view.serverTime)} />
      <MobilePanel
        initialView={view}
        details={
          <Suspense fallback={<DetailsSkeleton />}>
            <Details
              eventId={session.eventId}
              listingId={session.listingId}
              quantity={session.quantity}
            />
          </Suspense>
        }
        eventName={
          <Suspense fallback={null}>
            <EventName eventId={session.eventId} />
          </Suspense>
        }
        clientId={context.clientId}
        idempotencyKey={randomUUID()}
      />
    </DeviceFrame>
  );
}

async function Details({
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
      <h1 className="text-base font-bold leading-snug">{eventData.event.shortName}</h1>
      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
        {eventData.event.venueName}
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

function DetailsSkeleton() {
  return (
    <div aria-hidden>
      <Skeleton className="h-5 w-48" />
      <Skeleton className="mt-1.5 h-4 w-32" />
      <Skeleton className="mt-2.5 h-4 w-44" />
    </div>
  );
}

async function EventName({ eventId }: { eventId: string }) {
  const { event } = await getEventWithListings(eventId);
  return <>{event.shortName}</>;
}
