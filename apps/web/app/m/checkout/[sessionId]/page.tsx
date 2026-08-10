import { randomUUID } from "node:crypto";
import Link from "next/link";
import { formatClockTime } from "@gametime/contracts";
import { DeviceFrame, StatusBar } from "@/components/checkout/device-frame";
import { MobilePanel } from "@/components/checkout/mobile-panel";
import { PerfMarks } from "@/components/perf-marks";
import { buttonClass } from "@/components/ui";
import { ApiClientError, getCheckoutSession, getEventWithListings, getListing } from "@/lib/api";
import { clientContext } from "@/lib/surface";

export const dynamic = "force-dynamic";

/**
 * The second surface. Fetches the same session by the same id and renders it
 * server-side exactly as the desktop route does — the difference is entirely
 * presentational. Nothing about resuming is special-cased: a session is a
 * server-owned object with a URL, and any surface that can reach the URL can
 * continue the purchase.
 *
 * The one genuinely mobile concern is cold-start recovery: a deep link may be
 * opened hours later into a checkout that no longer exists, so that gets a real
 * screen rather than a 404.
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

  const [eventData, listing] = await Promise.all([
    getEventWithListings(view.session.eventId),
    getListing(view.session.listingId).catch(() => null),
  ]);

  return (
    <DeviceFrame>
      <PerfMarks route="checkout-mobile" />
      <StatusBar label={formatClockTime(view.serverTime)} />
      <MobilePanel
        initialView={view}
        event={eventData.event}
        listing={listing}
        clientId={context.clientId}
        idempotencyKey={randomUUID()}
      />
    </DeviceFrame>
  );
}
