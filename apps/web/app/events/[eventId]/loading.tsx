import { Card, Skeleton } from "@/components/ui";

/**
 * Without this file the router has nothing to show while navigating, so the
 * click feels unresponsive no matter how fast the server is.
 *
 * Deliberately not added to `/checkout/[sessionId]`. That page exists to put a
 * complete summary in the first HTML, and a loading screen at the route level
 * would replace exactly that.
 */
export default function LoadingEvent() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <Skeleton className="h-4 w-24" />

      <header className="mt-4 mb-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="mt-2 h-4 w-1/2" />
      </header>

      <ul className="space-y-3">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <Card className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="mt-2 h-4 w-56" />
                  <Skeleton className="mt-1.5 h-3 w-32" />
                </div>
                <div className="flex items-center gap-2">
                  <Skeleton className="h-[38px] w-28 rounded-lg" />
                  <Skeleton className="h-[42px] w-24 rounded-xl" />
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}
