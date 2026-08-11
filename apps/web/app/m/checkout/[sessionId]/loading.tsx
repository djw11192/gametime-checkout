import { DeviceFrame, StatusBar } from "@/components/checkout/device-frame";
import { Skeleton } from "@/components/ui";

/**
 * The phone equivalent of the desktop loading screen, and the more important of
 * the two: this is the surface reached by scanning a code, so the first paint
 * happens over whatever network the phone is on.
 *
 * Drawing the frame and the bottom bar here means the shell is already in place
 * when the session lands, rather than the layout assembling itself in two steps.
 */
export default function LoadingMobileCheckout() {
  return (
    <DeviceFrame>
      <StatusBar label="Gametime" />

      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <div>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-1.5 h-4 w-32" />
        </div>
        <div className="text-right">
          <Skeleton className="ml-auto h-3 w-14" />
          <Skeleton className="ml-auto mt-1.5 h-4 w-12" />
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 py-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-1.5 h-4 w-32" />
        <Skeleton className="mt-2.5 h-4 w-44" />

        {/* Matches the reserved drift-banner height in the real panel. */}
        <div className="mt-4 min-h-[7.5rem]" />

        <div className="mt-2 space-y-3 rounded-xl bg-slate-50 p-4 dark:bg-slate-900">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-5 w-32" />
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-2 flex items-baseline justify-between">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-[50px] w-full rounded-xl" />
      </div>
    </DeviceFrame>
  );
}
