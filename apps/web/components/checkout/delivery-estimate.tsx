import { getListing } from "@/lib/api";
import { Card, Skeleton } from "@/components/ui";

const DELIVERY_COPY: Record<string, { title: string; detail: string }> = {
  mobile_transfer: {
    title: "Mobile transfer",
    detail: "The seller transfers the tickets to your phone. Usually within an hour of purchase.",
  },
  instant_download: {
    title: "Instant download",
    detail: "Available in your account the moment the purchase completes.",
  },
  will_call: {
    title: "Will call",
    detail: "Collect at the box office with photo ID on the day.",
  },
};

/**
 * Stands in for looking up a delivery partner: worth showing, but not worth
 * making the fan wait on before they can see the price.
 *
 * It does its own fetching rather than taking the listing as a prop, which is
 * the whole point of the Suspense boundary around it — a prop would have to be
 * awaited by the page first, putting this back on the critical path and leaving
 * the boundary with nothing to defer.
 *
 * Its height must match `DeliveryEstimateSkeleton` below, so nothing on the
 * page moves when it appears.
 */
export async function DeliveryEstimate({ listingId }: { listingId: string }) {
  const listing = await getListing(listingId).catch(() => null);
  // Fake delay, standing in for a call to a delivery partner.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const copy = listing ? DELIVERY_COPY[listing.deliveryType] : undefined;

  return (
    <Card className="flex h-[5.5rem] items-center p-5">
      <div>
        <h2 className="text-sm font-semibold">{copy?.title ?? "Delivery"}</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {copy?.detail ?? "Delivery details will be confirmed after purchase."}
        </p>
      </div>
    </Card>
  );
}

export function DeliveryEstimateSkeleton() {
  return (
    <Card className="flex h-[5.5rem] items-center p-5" aria-hidden>
      <div className="w-full space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-64" />
      </div>
    </Card>
  );
}
