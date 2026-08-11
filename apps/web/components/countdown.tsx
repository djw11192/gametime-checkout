"use client";

import { useMemo, useSyncExternalStore } from "react";
import { EXPIRY_WARNING_MS, formatDuration } from "@gametime/contracts";
import { cn } from "@/lib/cn";

/** Holds the current second and tells React when it changes. */
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
   * Tick on the deadline's own second boundaries rather than every 1000ms from
   * whenever this mounted. That way two devices watching the same checkout
   * change their displayed number at the same moment.
   */
  private schedule = (): void => {
    const remainingMs = this.remaining();
    if (remainingMs <= 0) return; // Expired: the display cannot change again.

    // The extra 8ms lands just past the boundary, so `ceil` has already
    // dropped to the next value and we never fire twice on the same number.
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

/**
 * A countdown that already shows the right number in the server-rendered HTML,
 * before any JavaScript has run.
 *
 * The usual `useState` plus a `useEffect` timer would render `--:--` on the
 * server and only become real once the page had loaded and hydrated. On a
 * checkout page the timer is the whole point, so that gap matters.
 *
 * `useSyncExternalStore` avoids it. React calls `getServerSnapshot` both when
 * rendering on the server and again while hydrating, then switches to
 * `getSnapshot`. So the first HTML carries a real number from the server,
 * hydration matches it automatically, and the clock starts ticking a moment
 * later — with no mismatch to suppress.
 */
export function Countdown({
  expiresAt,
  serverRemainingMs,
  serverTime,
  className,
}: {
  expiresAt: string;
  /** Time left as the server measured it. This is what the first HTML shows. */
  serverRemainingMs: number;
  /** The server's clock at render time, used to spot a device clock set wrong. */
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
        // Tabular numerals keep every digit the same width, so the text does
        // not jitter and shove its neighbours around on every tick.
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
 * A difference smaller than this is page-load time, not a wrong clock.
 *
 * `serverTime` is stamped when the page renders and `Date.now()` is read when
 * it hydrates, so there is always a gap between them. Treating that gap as a
 * wrong clock would make the countdown run late by exactly that much. The case
 * actually worth correcting is a phone set minutes or hours off, which is far
 * too large to be page-load time.
 */
const SKEW_FLOOR_MS = 5_000;

function clockSkewMs(serverTime: string): number {
  const raw = new Date(serverTime).getTime() - Date.now();
  return Math.abs(raw) > SKEW_FLOOR_MS ? raw : 0;
}
