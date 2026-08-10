"use client";

import { useActionState, useEffect, useState } from "react";
import {
  formatCents,
  formatCentsPrecise,
  isTerminal,
  type CheckoutSessionView,
  type EventRecord,
} from "@gametime/contracts";
import { IDLE } from "@/app/checkout/action-state";
import { extendSessionAction } from "@/app/checkout/actions";
import { Countdown } from "@/components/countdown";
import { CompleteForm } from "@/components/checkout/complete-form";
import { DriftBanner } from "@/components/checkout/drift-banner";
import { CompletingState, TerminalState } from "@/components/checkout/session-states";
import { Row, buttonClass } from "@/components/ui";
import { useCheckoutSession, type StreamState } from "@/hooks/use-checkout-session";

/**
 * The live half of the checkout page. Seeded with the view the Server Component
 * already rendered, so its first client render is identical to the HTML that
 * shipped — no loading state, no flash, no refetch.
 */
export function CheckoutPanel({
  initialView,
  event,
  clientId,
  idempotencyKey,
}: {
  initialView: CheckoutSessionView;
  event: EventRecord;
  clientId: string;
  idempotencyKey: string;
}) {
  const { view, streamState } = useCheckoutSession({
    sessionId: initialView.session.id,
    initialView,
    surface: "web",
    clientId,
  });

  const { session } = view;
  const quote = view.liveQuote ?? session.acceptedQuote;

  // Nothing about a finished session can change, so there is no staleness worth
  // reporting here.
  if (isTerminal(session.status)) {
    return <TerminalState view={view} event={event} />;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        {/* No clock once the purchase is in flight: the deadline became this
            attempt's budget rather than the fan's shopping time, so it is not
            theirs to race any more. */}
        {session.status === "completing" ? (
          <span className="text-sm text-slate-500 dark:text-slate-400">Finishing up</span>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500 dark:text-slate-400">Holding your seats</span>
            <Countdown
              expiresAt={session.expiresAt}
              serverRemainingMs={view.remainingMs}
              serverTime={view.serverTime}
              className="text-base font-semibold"
            />
          </div>
        )}
        <StreamNotice state={streamState} />
      </header>

      {/* Height reserved on the server: a price change arriving over SSE must
          never insert content above the buy button and shove it under a thumb. */}
      <div className="min-h-[7.5rem]">
        <DriftBanner
          drift={view.drift}
          sessionId={session.id}
          surface="web"
          newQuoteHash={view.liveQuote?.hash ?? null}
        />
      </div>

      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/50">
        <Row
          label={`${formatCentsPrecise(quote.pricePerTicketCents)} × ${quote.quantity} ticket${quote.quantity > 1 ? "s" : ""}`}
          value={formatCentsPrecise(quote.subtotalCents)}
        />
        <Row label="Fees & delivery" value={formatCentsPrecise(quote.feesCents)} />
        <Row label="Total" value={formatCents(quote.totalCents)} emphasis />
      </div>

      {session.status === "completing" ? (
        <CompletingState view={view} />
      ) : (
        <>
          <CompleteForm view={view} surface="web" idempotencyKey={idempotencyKey} />
          {session.extensionsUsed === 0 && view.remainingMs < 3 * 60 * 1000 ? (
            <ExtendControl sessionId={session.id} />
          ) : null}
        </>
      )}
    </div>
  );
}

function ExtendControl({ sessionId }: { sessionId: string }) {
  const [state, formAction] = useActionState(extendSessionAction, IDLE);

  return (
    <form action={formAction} className="text-center">
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="surface" value="web" />
      <button type="submit" className={buttonClass("ghost", "text-xs")}>
        Need more time? Add 5 minutes
      </button>
      {state.status === "error" ? (
        <p className="text-xs text-slate-500">{state.message}</p>
      ) : null}
    </form>
  );
}

/** Long enough that a routine reconnect never surfaces, short enough that a real outage does. */
const DEGRADED_GRACE_MS = 2_000;

/**
 * Says something only when this surface has stopped receiving pushes. A
 * permanent "Live" badge reports on our infrastructure; what is worth saying is
 * the consequence — if the stream is down the price on screen may be stale, and
 * this is a page where that number moves.
 */
function StreamNotice({ state }: { state: StreamState }) {
  const degraded = state !== "live";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!degraded) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), DEGRADED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [degraded]);

  if (!visible) return null;

  return (
    <span role="status" className="text-xs font-medium text-amber-700 dark:text-amber-500">
      {state === "reconnecting" ? "Reconnecting…" : "Updates may be delayed"}
    </span>
  );
}
