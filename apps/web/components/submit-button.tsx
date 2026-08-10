"use client";

import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui";

/**
 * A submit button that knows its own form is in flight.
 *
 * `useFormStatus` reads the enclosing form's pending state, so no state has to
 * be threaded down from the page — and, more importantly, none of this is
 * required for the form to work. The server-rendered HTML already contains an
 * enabled button inside a `<form action=…>`; this only upgrades the feedback
 * once hydrated.
 */
export function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  className,
}: {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={buttonClass(variant, className)}>
      {pending ? pendingLabel : label}
    </button>
  );
}
