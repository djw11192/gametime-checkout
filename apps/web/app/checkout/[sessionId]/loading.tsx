import { Card, Skeleton } from "@/components/ui";

/**
 * Shown while the session itself is being fetched — the one thing this page
 * cannot render without.
 *
 * This does not replace the server-rendered summary; it precedes it. Next
 * flushes this immediately and streams the real page into the same response, so
 * the first HTML carries the layout instead of nothing, and a click from the
 * event page gets an answer straight away rather than sitting on the old screen.
 */
export default function LoadingCheckout() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <Skeleton className="h-4 w-28" />

      <Card className="mt-4 p-6">
        <div className="border-b border-slate-200 pb-4 dark:border-slate-800">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
          <Skeleton className="mt-2.5 h-4 w-56" />
        </div>

        <div className="space-y-4 pt-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-20" />
          </div>

          {/* Matches the reserved drift-banner height in the real panel. */}
          <div className="min-h-[7.5rem]" />

          <div className="space-y-3 rounded-xl bg-slate-50 p-4 dark:bg-slate-800/50">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-5 w-40" />
          </div>

          <Skeleton className="h-[50px] w-full rounded-xl" />
        </div>
      </Card>
    </main>
  );
}
