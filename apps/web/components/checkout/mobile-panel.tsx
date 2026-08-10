"use client";

import {
  formatCents,
  formatCentsPrecise,
  isTerminal,
  type CheckoutSessionView,
  type EventRecord,
  type Listing,
} from "@gametime/contracts";
import { Countdown } from "@/components/countdown";
import { CompleteForm } from "@/components/checkout/complete-form";
import { DriftBanner } from "@/components/checkout/drift-banner";
import { CompletingState, TerminalState } from "@/components/checkout/session-states";
import { Row } from "@/components/ui";
import { useCheckoutSession } from "@/hooks/use-checkout-session";

/**
 * Same session, same data, same server-rendered first paint as the desktop
 * panel — laid out for a thumb: scrolling content with the price and action
 * pinned to a bottom bar, and the countdown promoted into a persistent header.
 */
export function MobilePanel({
  initialView,
  event,
  listing,
  clientId,
  idempotencyKey,
}: {
  initialView: CheckoutSessionView;
  event: EventRecord;
  listing: Listing | null;
  clientId: string;
  idempotencyKey: string;
}) {
  const { view } = useCheckoutSession({
    sessionId: initialView.session.id,
    initialView,
    surface: "mobile",
    clientId,
  });

  const { session } = view;
  const quote = view.liveQuote ?? session.acceptedQuote;
  const terminal = isTerminal(session.status);
  const completing = session.status === "completing";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-600">Gametime</p>
          <p className="text-sm font-semibold">{terminal ? "Checkout" : "Complete purchase"}</p>
        </div>
        {/* Same as desktop: no clock once the purchase is in flight. */}
        {terminal || completing ? null : (
          <div className="text-right">
            <p className="text-[11px] text-slate-500">Seats held</p>
            <Countdown
              expiresAt={session.expiresAt}
              serverRemainingMs={view.remainingMs}
              serverTime={view.serverTime}
              className="text-sm font-bold"
            />
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {terminal ? (
          <TerminalState view={view} event={event} />
        ) : (
          <>
            <h1 className="text-base font-bold leading-snug">{event.shortName}</h1>
            <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{event.venueName}</p>
            {listing ? (
              <p className="mt-2 text-sm font-medium">
                Section {listing.section} · Row {listing.row} · {session.quantity} ticket
                {session.quantity > 1 ? "s" : ""}
              </p>
            ) : null}

            <div className="mt-4 min-h-[7.5rem]">
              <DriftBanner
                drift={view.drift}
                sessionId={session.id}
                surface="mobile"
                newQuoteHash={view.liveQuote?.hash ?? null}
              />
            </div>

            <div className="mt-2 rounded-xl bg-slate-50 p-4 dark:bg-slate-900">
              <Row
                label={`${formatCentsPrecise(quote.pricePerTicketCents)} × ${quote.quantity}`}
                value={formatCentsPrecise(quote.subtotalCents)}
              />
              <Row label="Fees & delivery" value={formatCentsPrecise(quote.feesCents)} />
              <Row label="Total" value={formatCents(quote.totalCents)} emphasis />
            </div>

            {completing ? (
              <div className="mt-4">
                <CompletingState view={view} />
              </div>
            ) : null}

            <p className="mt-4 text-center text-[11px] text-slate-400">
              Resumed from {session.origin.surface} · v{session.version}
            </p>
          </>
        )}
      </div>

      {/* Sticky action bar, safe-area padded so it clears the home indicator. */}
      {terminal || completing ? null : (
        <div className="border-t border-slate-200 bg-white px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 dark:border-slate-800 dark:bg-slate-950">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm text-slate-600 dark:text-slate-400">Total</span>
            <span className="text-lg font-bold tabular-nums">{formatCents(quote.totalCents)}</span>
          </div>
          <CompleteForm view={view} surface="mobile" idempotencyKey={idempotencyKey} fullWidth />
        </div>
      )}
    </div>
  );
}
