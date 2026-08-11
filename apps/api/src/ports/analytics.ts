import type { Surface } from "@gametime/contracts";

/**
 * The three events needed to answer the question this feature exists for: do
 * fans who switch devices mid-checkout complete more often than fans who don't?
 *
 * A standard conversion funnel cannot answer that, because it has no idea two
 * page views were the same checkout. So the device switch is recorded directly
 * rather than inferred later. Where these get sent is wired up in
 * `container.ts`; see the README for that tradeoff.
 */
export type AnalyticsEvent =
  /** A second surface picked up a checkout the first one started. */
  | {
      type: "session.resumed";
      sessionId: string;
      fromSurface: Surface;
      toSurface: Surface;
      gapSeconds: number;
      viaDeepLink: boolean;
    }
  /** `surfaceCount > 1` is a checkout that survived an interruption. */
  | { type: "checkout.completed"; sessionId: string; surfaceCount: number }
  /** Should never be zero in production; if it is, the guard is untested. */
  | { type: "duplicate.blocked"; sessionId: string };

export interface AnalyticsSink {
  /** Synchronous and must not throw — analytics is never a reason a checkout fails. */
  emit(event: AnalyticsEvent): void;
}

export class ConsoleAnalyticsSink implements AnalyticsSink {
  emit(event: AnalyticsEvent): void {
    console.log("[analytics]", JSON.stringify(event));
  }
}

/** Lets a test assert the handoff was measured, not just that it worked. */
export class InMemoryAnalyticsSink implements AnalyticsSink {
  private captured: AnalyticsEvent[] = [];

  emit(event: AnalyticsEvent): void {
    this.captured.push(event);
  }

  events(): AnalyticsEvent[] {
    return [...this.captured];
  }

  clear(): void {
    this.captured = [];
  }
}
