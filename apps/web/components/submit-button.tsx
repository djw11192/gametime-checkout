"use client";

import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui";

/**
 * None of this is needed for the form to work. The server-rendered HTML already
 * has a working button inside a `<form action=…>`; this only improves the
 * feedback once the page has loaded.
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
