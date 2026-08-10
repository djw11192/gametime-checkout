"use client";

import { useActionState } from "react";
import { formatCents, type Drift, type Surface } from "@gametime/contracts";
import { IDLE } from "@/app/checkout/action-state";
import { acknowledgeQuoteAction } from "@/app/checkout/actions";
import { SubmitButton } from "@/components/submit-button";
import { cn } from "@/lib/cn";

/**
 * What the fan sees when the world moved while they were away.
 *
 * The slot this renders into reserves its height on the server, so a price
 * change arriving over SSE cannot insert content above the buy button and shove
 * it under someone's thumb mid-tap.
 */
export function DriftBanner({
  drift,
  sessionId,
  surface,
  newQuoteHash,
}: {
  drift: Drift[];
  sessionId: string;
  surface: Surface;
  newQuoteHash: string | null;
}) {
  const first = drift[0];
  if (!first) return null;

  if (first.type === "inventory_unavailable") {
    return (
      <Shell tone="danger" title="These tickets are gone">
        <p>The seller sold them on another channel while you were away. Nothing was charged.</p>
      </Shell>
    );
  }

  if (first.type === "quantity_reduced") {
    return (
      <Shell tone="danger" title="Not enough tickets left">
        <p>
          Only {first.availableQuantity} of the {first.requestedQuantity} tickets you selected are
          still available. Start a new checkout to buy what remains.
        </p>
      </Shell>
    );
  }

  const increased = first.type === "price_increased";

  return (
    <Shell
      tone={increased ? "warning" : "info"}
      title={increased ? "The price went up while you were away" : "Good news — the price dropped"}
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="line-through opacity-60">{formatCents(first.fromCents)}</span>
        <span className="text-base font-semibold">{formatCents(first.toCents)}</span>
        <span className="text-sm font-medium">
          {increased ? "+" : "−"}
          {formatCents(first.deltaCents)}
        </span>
      </p>
      <p className="mt-1 opacity-80">
        We won&apos;t charge you a price you haven&apos;t seen. Accept the new total to continue.
      </p>

      {newQuoteHash ? (
        <AcceptForm sessionId={sessionId} surface={surface} quoteHash={newQuoteHash} />
      ) : null}
    </Shell>
  );
}

function AcceptForm({
  sessionId,
  surface,
  quoteHash,
}: {
  sessionId: string;
  surface: Surface;
  quoteHash: string;
}) {
  const [state, formAction] = useActionState(acknowledgeQuoteAction, IDLE);

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="surface" value={surface} />
      <input type="hidden" name="quoteHash" value={quoteHash} />
      <SubmitButton
        label="Accept new price"
        pendingLabel="Updating…"
        className="w-full sm:w-auto"
      />
      {state.status === "error" ? (
        <p className="mt-2 text-xs text-red-700">{state.message}</p>
      ) : null}
    </form>
  );
}

const TONES = {
  warning: "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40",
  danger: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
  info: "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40",
} as const;

function Shell({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" className={cn("rounded-xl border p-4 text-sm", TONES[tone])}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
