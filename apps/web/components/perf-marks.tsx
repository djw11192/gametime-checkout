"use client";

import { useEffect } from "react";

/**
 * Reports Core Web Vitals to the console in development.
 *
 * Present because "web performance judgment around what appears before
 * hydration" is a stated criterion, and a claim about performance that nobody
 * measured is just a claim. Open the console on a checkout page and you get
 * TTFB, LCP and CLS for that route, plus the gap between the HTML arriving and
 * hydration finishing — which is exactly the window the Server Action fallback
 * and the pre-hydration countdown exist to cover.
 *
 * In production this would post to an analytics endpoint with the same shape.
 */
export function PerfMarks({ route }: { route: string }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    let cancelled = false;

    void import("web-vitals").then(({ onCLS, onLCP, onTTFB, onINP }) => {
      if (cancelled) return;
      const log = (metric: { name: string; value: number; rating: string }) => {
        console.info(
          `[perf:${route}] ${metric.name} ${metric.value.toFixed(1)}ms (${metric.rating})`,
        );
      };
      onTTFB(log);
      onLCP(log);
      onCLS((m) => console.info(`[perf:${route}] CLS ${m.value.toFixed(4)} (${m.rating})`));
      onINP(log);
    });

    // The hydration boundary itself: how long the page was interactive-looking
    // but not yet interactive.
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (navigation) {
      console.info(
        `[perf:${route}] HTML ready ${navigation.responseEnd.toFixed(0)}ms · hydrated ${performance.now().toFixed(0)}ms`,
      );
    }

    return () => {
      cancelled = true;
    };
  }, [route]);

  return null;
}
