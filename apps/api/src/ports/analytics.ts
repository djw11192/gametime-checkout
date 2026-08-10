import type { AnalyticsEvent, Funnel } from "@gametime/contracts";

/** In production a batched write to Segment/Kafka; here an in-memory aggregate. */
export class InMemoryAnalyticsSink {
  private events: AnalyticsEvent[] = [];
  /** Terminal outcome per session, so a retried checkout is not counted twice. */
  private outcomes = new Map<string, { converted: boolean; surfaceCount: number }>();
  private resumeGaps: number[] = [];
  /** Sessions, not events: a fan who bounces between two devices is one handoff. */
  private handedOff = new Set<string>();

  track(event: AnalyticsEvent): void {
    this.events.push(event);

    if (event.name === "session_resumed") {
      this.resumeGaps.push(event.gapSeconds);
      if (event.fromSurface !== event.toSurface) this.handedOff.add(event.sessionId);
    }
    if (event.name === "completion_succeeded") {
      this.outcomes.set(event.sessionId, { converted: true, surfaceCount: event.surfaceCount });
    }
    if (event.name === "session_expired" && !this.outcomes.get(event.sessionId)?.converted) {
      this.outcomes.set(event.sessionId, { converted: false, surfaceCount: event.surfaceCount });
    }
  }

  funnel(): Funnel {
    const count = (name: AnalyticsEvent["name"]) => this.events.filter((e) => e.name === name).length;
    const rate = (completed: number, total: number) => (total === 0 ? 0 : completed / total);

    const outcomes = [...this.outcomes.values()];
    const single = outcomes.filter((o) => o.surfaceCount <= 1);
    const multi = outcomes.filter((o) => o.surfaceCount > 1);
    const converted = (list: typeof outcomes) => list.filter((o) => o.converted).length;

    const resumed = this.events.filter((e) => e.name === "session_resumed");

    return {
      created: count("session_created"),
      resumed: resumed.length,
      resumedCrossSurface: resumed.filter(
        (e) => e.name === "session_resumed" && e.fromSurface !== e.toSurface,
      ).length,
      handedOffSessions: this.handedOff.size,
      driftShown: count("drift_shown"),
      driftAccepted: count("drift_accepted"),
      completed: count("completion_succeeded"),
      failed: count("completion_failed"),
      expired: count("session_expired"),
      duplicatesBlocked: count("completion_blocked_duplicate"),

      singleSurface: {
        completed: converted(single),
        total: single.length,
        rate: rate(converted(single), single.length),
      },
      multiSurface: {
        completed: converted(multi),
        total: multi.length,
        rate: rate(converted(multi), multi.length),
      },

      medianResumeGapSeconds: median(this.resumeGaps),
    };
  }

  clear(): void {
    this.events = [];
    this.outcomes.clear();
    this.resumeGaps = [];
    this.handedOff.clear();
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : (lo + hi) / 2;
}
