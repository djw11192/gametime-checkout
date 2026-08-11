"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import {
  formatCents,
  formatCentsPrecise,
  isTerminal,
  type CheckoutSessionView,
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
 * The part of the checkout page that updates live. It starts from the view the
 * server already rendered, so its first render in the browser matches the HTML
 * exactly: no loading state and no refetch.
 */
export function CheckoutPanel({
  initialView,
  eventName,
  clientId,
  idempotencyKey,
}: {
  initialView: CheckoutSessionView;
  /** Streamed in by the page; nothing here waits on it. */
  eventName: ReactNode;
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

  // A finished session cannot change, so there is nothing to warn about if the
  // update stream drops.
  if (isTerminal(session.status)) {
    return <TerminalState view={view} eventName={eventName} />;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        {/* No countdown once the purchase is under way: the deadline now
            measures how long this attempt has, not how long the fan has. */}
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

      {/* Height reserved up front so that a price change arriving mid-tap
          cannot push the buy button out from under someone's thumb. */}
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
        <CompletingState view={view} surface="web" />
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

/** Long enough that a routine reconnect stays hidden, short enough to show a real outage. */
const DEGRADED_GRACE_MS = 2_000;

/** Shown only when this device has stopped receiving updates. */
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
