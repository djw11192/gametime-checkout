import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The handful of primitives this prototype needs: plain Tailwind, variants as string maps. */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-slate-200 bg-white shadow-sm",
        "dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      {children}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600 disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-500",
  secondary:
    "bg-white text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700 dark:hover:bg-slate-800",
  ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  danger: "bg-red-600 text-white hover:bg-red-700",
} as const;

export function buttonClass(
  variant: keyof typeof BUTTON_VARIANTS = "primary",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold",
    "transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
    // `<button>` defaults to an arrow, so the pointer is opt-in. Set here rather
    // than on the buy button alone: it sits directly above "Add 5 minutes", and
    // one control feeling clickable while its neighbour doesn't is worse than
    // either choice applied consistently. `:disabled` outranks it on specificity,
    // so a blocked button still reads as blocked.
    "cursor-pointer disabled:cursor-not-allowed",
    BUTTON_VARIANTS[variant],
    className,
  );
}

/** A shimmer block. Callers set the dimensions, so a fallback can match the height of what replaces it. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded bg-slate-200 dark:bg-slate-800", className)}
    />
  );
}

export function Row({
  label,
  value,
  emphasis,
}: {
  label: ReactNode;
  value: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-1.5 text-sm",
        emphasis && "border-t border-slate-200 pt-3 text-base font-semibold dark:border-slate-800",
      )}
    >
      <span className={cn(!emphasis && "text-slate-600 dark:text-slate-400")}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
