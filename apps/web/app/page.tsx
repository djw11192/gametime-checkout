import Link from "next/link";
import { formatEventDate } from "@gametime/contracts";
import { listEvents } from "@/lib/api";
import { Card } from "@/components/ui";

export const metadata = { title: "Gametime — Tickets" };

/**
 * Browsing is cacheable; checkout is not. Only works because `listEvents` opts
 * into caching at the fetch layer too — an uncached fetch anywhere in a route
 * makes the whole route dynamic, so this alone would quietly do nothing.
 */
export const revalidate = 60;

export default async function HomePage() {
  const events = await listEvents();

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">Gametime</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Tonight&apos;s tickets</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-400">
          A checkout-continuity prototype. Start a purchase here, then pick it up on another
          device.
        </p>
        <Link
          href="/demo"
          className="mt-3 inline-block text-sm font-medium text-brand-600 underline underline-offset-4"
        >
          Open the demo console →
        </Link>
      </header>

      <ul className="space-y-3">
        {events.map((event) => (
          <li key={event.id}>
            <Link href={`/events/${event.id}`} className="block">
              <Card className="p-5 transition-shadow hover:shadow-md">
                <div className="flex items-baseline justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">{event.name}</h2>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                      {event.venueName} · {event.city}, {event.state}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm text-slate-500">
                    {formatEventDate(event.startsAt)}
                  </span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
