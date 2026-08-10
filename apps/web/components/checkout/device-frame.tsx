import type { ReactNode } from "react";

/**
 * Phone chrome for the simulated mobile surface.
 *
 * Only drawn from `sm:` upwards. On a real handset — which is what you get when
 * you scan the QR — the frame disappears and the surface is simply the page,
 * full-bleed with a safe-area-aware action bar. A reviewer on a laptop sees a
 * phone; a reviewer with their actual phone sees the real thing. Same route,
 * same HTML.
 */
export function DeviceFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh justify-center bg-slate-50 sm:items-center sm:bg-slate-200 sm:py-10 dark:bg-slate-950 sm:dark:bg-slate-900">
      <div
        className={[
          "relative flex w-full flex-col bg-white dark:bg-slate-950",
          "min-h-dvh sm:min-h-0 sm:h-[812px] sm:w-[390px] sm:shrink-0",
          "sm:overflow-hidden sm:rounded-[2.75rem] sm:border-[10px] sm:border-slate-900",
          "sm:shadow-2xl dark:sm:border-slate-800",
        ].join(" ")}
      >
        <div aria-hidden className="hidden sm:block">
          <div className="absolute left-1/2 top-0 z-20 h-6 w-32 -translate-x-1/2 rounded-b-2xl bg-slate-900 dark:bg-slate-800" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:pt-6">{children}</div>
      </div>
    </div>
  );
}

/** iOS-style status bar. Cosmetic, but it sells the "this is the app" framing. */
export function StatusBar({ label }: { label: string }) {
  return (
    <div className="hidden items-center justify-between px-6 pb-1 pt-1 text-[11px] font-semibold text-slate-900 sm:flex dark:text-slate-100">
      <span>{label}</span>
    </div>
  );
}
