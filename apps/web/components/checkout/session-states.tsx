import Link from "next/link";
import { formatCents, type CheckoutSessionView, type EventRecord } from "@gametime/contracts";
import { buttonClass } from "@/components/ui";

/**
 * Terminal-state screens. Each has to answer two questions immediately: was I
 * charged, and what can I do now. A dead-end "session not found" fails both,
 * which is why the API keeps serving expired sessions with their full context.
 */
export function TerminalState({
  view,
  event,
}: {
  view: CheckoutSessionView;
  event: EventRecord;
}) {
  const { session } = view;
  const browse = (
    <Link href={`/events/${session.eventId}`} className={buttonClass("primary")}>
      See other tickets
    </Link>
  );

  if (session.status === "completed") {
    return (
      <Panel tone="success" icon="✓" title="You're going">
        <p>
          {session.quantity} ticket{session.quantity > 1 ? "s" : ""} to {event.shortName}
        </p>
        <p className="mt-1 font-semibold">
          Charged {formatCents(session.acceptedQuote.totalCents)}
        </p>
        {session.completion?.orderId ? (
          <p className="mt-3 text-xs opacity-70">Order {session.completion.orderId}</p>
        ) : null}
        {session.surfacesSeen.length > 1 ? (
          <p className="mt-2 text-xs opacity-70">
            Started on {session.origin.surface}, finished on{" "}
            {session.completion?.startedBySurface ?? session.lastSeen.surface}.
          </p>
        ) : null}
      </Panel>
    );
  }

  if (session.status === "expired") {
    const stillListed = view.liveQuote !== null;
    return (
      <Panel
        tone="neutral"
        icon="⏱"
        title="This checkout expired"
        action={
          <Link href={`/events/${session.eventId}`} className={buttonClass("primary")}>
            {stillListed ? "Start a new checkout" : "See other tickets"}
          </Link>
        }
      >
        <p>We released the hold so other fans could buy. Nothing was charged.</p>
        <p className="mt-2">
          {stillListed ? (
            <>
              Those seats are still listed at{" "}
              <strong>{formatCents(view.liveQuote!.totalCents)}</strong> for {session.quantity}.
            </>
          ) : (
            "Those seats are no longer available."
          )}
        </p>
      </Panel>
    );
  }

  if (session.status === "failed") {
    return (
      <Panel tone="danger" icon="✕" title="We couldn't complete this purchase" action={browse}>
        <p>{session.completion?.failure?.message ?? "The purchase could not be completed."}</p>
        <p className="mt-2 opacity-80">Nothing was charged.</p>
      </Panel>
    );
  }

  return (
    <Panel tone="neutral" icon="—" title="Checkout cancelled" action={browse}>
      <p>Nothing was charged.</p>
    </Panel>
  );
}

const TONES = {
  success: "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
  danger: "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100",
  neutral: "bg-slate-100 text-slate-900 dark:bg-slate-800/60 dark:text-slate-100",
} as const;

function Panel({
  tone,
  icon,
  title,
  action,
  children,
}: {
  tone: keyof typeof TONES;
  icon: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl p-5 text-sm ${TONES[tone]}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-lg leading-none">
          {icon}
        </span>
        <div className="flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="mt-1">{children}</div>
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** Not terminal, but not actionable either: another device holds the lock. */
export function CompletingState({ view }: { view: CheckoutSessionView }) {
  const pending = view.session.completion?.status === "pending";

  return (
    <div className="rounded-xl bg-brand-50 p-5 text-sm text-brand-700 dark:bg-brand-700/15 dark:text-brand-100">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="size-2.5 shrink-0 animate-pulse rounded-full bg-brand-600 dark:bg-brand-100"
        />
        <div>
          <p className="font-semibold">
            {pending ? "Confirming with your bank" : "Completing this purchase"}
          </p>
          <p className="mt-0.5">
            Finishing on your {view.session.completion?.startedBySurface === "mobile" ? "phone" : "other device"}.
            Don&apos;t buy again — you&apos;d be charged twice.
          </p>
        </div>
      </div>
    </div>
  );
}
