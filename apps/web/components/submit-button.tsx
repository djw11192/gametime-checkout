"use client";

import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui";

/**
 * `useFormStatus` reads the enclosing form's pending state, so nothing has to be
 * threaded down from the page. None of it is required for the form to work — the
 * server-rendered HTML already contains an enabled button inside a
 * `<form action=…>`; this only upgrades the feedback once hydrated.
 */
export function SubmitButton({
  label,
  pendingLabel,
  className,
}: {
  label: string;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={buttonClass("primary", className)}>
      {pending ? pendingLabel : label}
    </button>
  );
}
