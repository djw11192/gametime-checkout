import { getListing } from "@/lib/api";
import { Card, Skeleton } from "@/components/ui";

/**
 * A deliberately slow secondary panel, used to demonstrate streaming.
 *
 * In production this is the kind of thing that calls a delivery-partner API and
 * occasionally takes a second: useful, but not something a fan should wait on
 * before seeing the price they are about to pay. Behind a Suspense boundary it
 * arrives late without holding up the shell — and because the skeleton below is
 * exactly its height, the page does not move when it lands.
 */
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

export async function DeliveryEstimate({ listingId }: { listingId: string }) {
  const listing = await getListing(listingId).catch(() => null);

  // Simulates the third-party latency this boundary exists to absorb. Long
  // enough that the skeleton is unmistakably visible, short enough not to sit
  // on the primary conversion path — this route is where every Checkout click
  // lands.
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
