import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  formatCents,
  formatCentsPrecise,
  formatEventDate,
  type Surface,
} from "@gametime/contracts";
import {
  ApiClientError,
  createCheckoutSession,
  getEventWithListings,
  listEvents,
} from "@/lib/api";
import { getClientId } from "@/lib/surface";
import { SubmitButton } from "@/components/submit-button";
import { Card } from "@/components/ui";
import { CheckoutError } from "./checkout-error";

/** Cached for 30s; every fan browsing this event sees the same listings. */
export const revalidate = 30;

/**
 * Build these pages ahead of time. Any event not listed here is still rendered
 * on first request and cached from then on, since `dynamicParams` defaults to
 * true.
 */
export async function generateStaticParams() {
  const events = await listEvents();
  return events.map((event) => ({ eventId: event.id }));
}

/**
 * Picking a listing creates the checkout session. A plain form POST to a Server
 * Action, so the session — and with it the URL the fan can resume from — exists
 * before any client JavaScript has run.
 */
async function startCheckout(formData: FormData) {
  "use server";

  const listingId = String(formData.get("listingId"));
  const quantity = Number(formData.get("quantity") ?? 2);
  const surface = (String(formData.get("surface")) as Surface) || "web";

  let sessionId: string;
  try {
    const view = await createCheckoutSession({
      listingId,
      quantity,
      surface,
      clientId: await getClientId(),
    });
    sessionId = view.session.id;
  } catch (error) {
    if (error instanceof ApiClientError) {
      redirect(`/events/${formData.get("eventId")}?error=${error.code}`);
    }
    throw error;
  }

  redirect(`/checkout/${sessionId}`);
}

export default async function EventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  const data = await getEventWithListings(eventId).catch(() => null);
  if (!data) notFound();

  const { event, listings } = data;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <Link href="/" className="text-sm text-slate-500 hover:underline">
        ← All events
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{event.name}</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {formatEventDate(event.startsAt)} · {event.venueName}, {event.city}
        </p>
      </header>

      {/* `useSearchParams` needs a Suspense boundary in a cached route: the page is
          prerendered, this resolves once the client knows the URL. */}
      <Suspense fallback={null}>
        <CheckoutError />
      </Suspense>

      <ul className="space-y-3">
        {listings.map((listing) => (
          <li key={listing.id}>
            <Card className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold">
                    Section {listing.section} · Row {listing.row}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {formatCentsPrecise(listing.pricePerTicketCents)} each ·{" "}
                    {listing.availableQuantity} available
                    {listing.disclosures.length > 0 ? ` · ${listing.disclosures.join(", ")}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatCents(listing.pricePerTicketCents + listing.feesPerTicketCents)} all-in
                    per ticket
                  </p>
                </div>

                <form action={startCheckout} className="flex items-center gap-2">
                  <input type="hidden" name="listingId" value={listing.id} />
                  <input type="hidden" name="eventId" value={event.id} />
                  <input type="hidden" name="surface" value="web" />
                  <label className="sr-only" htmlFor={`qty-${listing.id}`}>
                    Quantity
                  </label>
                  <select
                    id={`qty-${listing.id}`}
                    name="quantity"
                    defaultValue={Math.min(2, listing.availableQuantity)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  >
                    {Array.from({ length: Math.min(4, listing.availableQuantity) }, (_, i) => i + 1).map(
                      (n) => (
                        <option key={n} value={n}>
                          {n} ticket{n > 1 ? "s" : ""}
                        </option>
                      ),
                    )}
                  </select>
                  <SubmitButton label="Checkout" pendingLabel="Starting…" />
                </form>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}
