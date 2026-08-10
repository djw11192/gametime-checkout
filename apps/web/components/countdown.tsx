"use client";

import { useMemo, useSyncExternalStore } from "react";
import { EXPIRY_WARNING_MS, formatDuration } from "@gametime/contracts";
import { cn } from "@/lib/cn";

/**
 * A countdown that is correct before hydration.
 *
 * `useState` plus a `useEffect` timer renders `--:--` on the server and only
 * becomes real once JavaScript has loaded and hydrated. `useSyncExternalStore`
 * avoids that: React calls `getServerSnapshot` during SSR *and* during
 * hydration, then switches to `getSnapshot`. The first paint shows a real number
 * computed by the server, hydration matches it by construction, and the clock
 * starts a frame later — no mismatch, and no `suppressHydrationWarning` papering
 * over a difference nobody checked.
 */
class CountdownStore {
  private listeners = new Set<() => void>();
  private snapshot: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deadlineMs: number,
    private readonly skewMs: number,
    private readonly serverSnapshot: number,
  ) {
    this.snapshot = serverSnapshot;
  }

  private remaining(): number {
    return this.deadlineMs - (Date.now() + this.skewMs);
  }

  /** Bucketed to whole seconds so the snapshot is stable between ticks. */
  private compute(): number {
    return Math.max(0, Math.ceil(this.remaining() / 1000));
  }

  /**
   * Wake on the deadline's own second boundaries rather than a fixed interval,
   * so two surfaces watching one session flip at the same instant instead of on
   * whatever phase each happened to mount on.
   */
  private schedule = (): void => {
    const remainingMs = this.remaining();
    if (remainingMs <= 0) return; // Expired: the display cannot change again.

    // The margin lands just past the boundary, so `ceil` has decremented and we
    // never fire twice on the same value.
    this.timer = setTimeout(this.tick, (remainingMs % 1000) + 8);
  };

  private tick = (): void => {
    const next = this.compute();
    if (next !== this.snapshot) {
      this.snapshot = next;
      for (const l of this.listeners) l();
    }
    this.schedule();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    if (!this.timer) {
      this.snapshot = this.compute();
      this.schedule();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };

  getSnapshot = (): number => this.snapshot;
  getServerSnapshot = (): number => this.serverSnapshot;
}

export function Countdown({
  expiresAt,
  serverRemainingMs,
  serverTime,
  className,
}: {
  expiresAt: string;
  /** Remaining time as the server measured it — what the first paint shows. */
  serverRemainingMs: number;
  /** The server's clock at render time, used to detect a badly skewed device clock. */
  serverTime: string;
  className?: string;
}) {
  const store = useMemo(() => {
    return new CountdownStore(
      new Date(expiresAt).getTime(),
      typeof window === "undefined" ? 0 : clockSkewMs(serverTime),
      Math.ceil(serverRemainingMs / 1000),
    );
  }, [expiresAt, serverRemainingMs, serverTime]);

  const seconds = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  const urgent = seconds * 1000 <= EXPIRY_WARNING_MS;

  return (
    <span
      className={cn(
        // Tabular numerals stop the width jittering as digits change, which
        // would otherwise nudge everything beside it on every tick.
        "font-mono tabular-nums transition-colors",
        urgent ? "text-red-600 dark:text-red-400" : "text-slate-700 dark:text-slate-200",
        className,
      )}
      aria-live={urgent ? "polite" : "off"}
    >
      {formatDuration(seconds * 1000)}
    </span>
  );
}

/**
 * Anything under this is page-load latency, not a wrong clock. `serverTime` is
 * stamped at render and `Date.now()` read at hydration; subtracting the gap
 * between them as though it were skew makes the countdown run late by exactly
 * that much. The case worth correcting is the phone that is minutes or hours
 * off, which is far too large to be latency.
 */
const SKEW_FLOOR_MS = 5_000;

function clockSkewMs(serverTime: string): number {
  const raw = new Date(serverTime).getTime() - Date.now();
  return Math.abs(raw) > SKEW_FLOOR_MS ? raw : 0;
}
