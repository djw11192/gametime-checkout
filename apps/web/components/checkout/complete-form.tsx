"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  formatCents,
  type BlockerCode,
  type CheckoutSessionView,
  type Surface,
} from "@gametime/contracts";
import { IDLE } from "@/app/checkout/action-state";
import { completeCheckoutAction } from "@/app/checkout/actions";
import { buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * A real `<form>` posting to a Server Action rather than an onClick handler, so
 * it works before the page has finished loading.
 *
 * The disabled state comes from the server's `blockers` list rather than being
 * worked out here. Deciding it locally as well is how the two versions drift
 * apart and the fan ends up with a button that always gets refused.
 */
export function CompleteForm({
  view,
  surface,
  idempotencyKey,
  fullWidth,
}: {
  view: CheckoutSessionView;
  surface: Surface;
  /**
   * Generated once per server render, so a double-click sends the same key
   * twice and the API treats it as one request. A retry after a decline gets a
   * fresh render, and therefore a fresh key.
   */
  idempotencyKey: string;
  fullWidth?: boolean;
}) {
  const [state, formAction] = useActionState(completeCheckoutAction, IDLE);
  const quoteHash = view.liveQuote?.hash ?? view.session.acceptedQuote.hash;

  return (
    <form action={formAction} className={cn(fullWidth && "w-full")}>
      <input type="hidden" name="sessionId" value={view.session.id} />
      <input type="hidden" name="surface" value={surface} />
      <input type="hidden" name="quoteHash" value={quoteHash} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <CompleteButton view={view} />

      {state.status === "error" ? (
        <p
          role="alert"
          className="mt-2 text-center text-xs text-red-700 dark:text-red-400"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function CompleteButton({ view }: { view: CheckoutSessionView }) {
  const { pending } = useFormStatus();
  const total = view.liveQuote?.totalCents ?? view.session.acceptedQuote.totalCents;

  return (
    // No `aria-describedby` needed: the reason the purchase is blocked is the
    // button's own label, so a screen reader already announces it.
    <button
      type="submit"
      disabled={!view.canComplete || pending}
      className={buttonClass("primary", "w-full py-3 text-base")}
    >
      {pending ? "Completing…" : labelFor(view, total)}
    </button>
  );
}

function labelFor(view: CheckoutSessionView, totalCents: number): string {
  const blocker = view.blockers[0];
  if (!blocker) return `Complete purchase · ${formatCents(totalCents)}`;
  return BLOCKER_LABEL[blocker];
}

/** The button's label says why it cannot be pressed. */
const BLOCKER_LABEL: Record<BlockerCode, string> = {
  session_expired: "This checkout expired",
  session_terminal: "This checkout is closed",
  completion_in_progress: "Completing on your other device…",
  quote_unacknowledged: "Accept the new price to continue",
  inventory_unavailable: "These tickets are gone",
};
