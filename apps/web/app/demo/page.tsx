import { redirect } from "next/navigation";
import Link from "next/link";
import { DEMO_LISTING_ID } from "@gametime/contracts";
import { DemoConsole } from "@/components/demo/demo-console";
import { buttonClass } from "@/components/ui";
import { createCheckoutSession } from "@/lib/api";
import { getClientId } from "@/lib/surface";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checkout Continuity — Demo Console" };

async function startDemoSession() {
  "use server";
  const view = await createCheckoutSession({
    listingId: DEMO_LISTING_ID,
    quantity: 2,
    surface: "web",
    clientId: await getClientId(),
  });
  redirect(`/demo?session=${view.session.id}`);
}

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;

  if (!session) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-16">
        <h1 className="text-2xl font-bold tracking-tight">Checkout continuity — demo console</h1>
        <p className="mt-3 text-slate-600 dark:text-slate-400">
          Creates one checkout session and shows it on two surfaces at once, with controls to move
          the price, pull the inventory, break the payment processor, and run the clock out.
        </p>
        <form action={startDemoSession} className="mt-6">
          <button type="submit" className={buttonClass("primary")}>
            Start a demo session
          </button>
        </form>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-500 underline underline-offset-4">
          or browse the catalogue normally
        </Link>
      </main>
    );
  }

  return <DemoConsole sessionId={session} listingId={DEMO_LISTING_ID} />;
}
