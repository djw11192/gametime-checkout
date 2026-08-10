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
 * it works before hydration finishes — on a mid-range phone on a stadium network
 * that is not a theoretical window.
 *
 * The disabled state mirrors the server's `blockers` array rather than being
 * decided locally: duplicating that logic client-side is how the two drift apart
 * and the fan ends up clicking something that always 409s.
 */
export function CompleteForm({
  view,
  surface,
  idempotencyKey,
  fullWidth,
}: {
  view: CheckoutSessionView;
  surface: Surface;
  /** Generated once per render on the server, so a double-click posts one key. */
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
    // No `aria-describedby`: the reason a purchase is blocked is the button's
    // own label, so it is already in the accessible name.
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

/**
 * The button says why it cannot be pressed. A greyed-out control with no
 * explanation is the least useful thing a checkout can show someone whose
 * purchase just stopped working.
 */
const BLOCKER_LABEL: Record<BlockerCode, string> = {
  session_expired: "This checkout expired",
  session_terminal: "This checkout is closed",
  completion_in_progress: "Completing on your other device…",
  quote_unacknowledged: "Accept the new price to continue",
  inventory_unavailable: "These tickets are gone",
};
