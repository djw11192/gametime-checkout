import type { Surface } from "./catalog";

/**
 * Plain TypeScript types, not Zod: analytics is server-side only. Events are
 * constructed here and the funnel is serialised out, so nothing on this file's
 * path ever parses untrusted input.
 *
 * The design point is that the handoff is a first-class dimension. A generic
 * funnel tells you sessions converted at N%; it cannot tell you whether the fan
 * who switched devices converted better than the fan who didn't, which is the
 * only question that justifies building continuity at all.
 */
export type AnalyticsEvent =
  | { name: "session_created"; at: string; sessionId: string; surface: Surface }
  | {
      name: "session_resumed";
      at: string;
      sessionId: string;
      fromSurface: Surface;
      toSurface: Surface;
      /** Wall-clock gap since the session was last touched — the "interruption". */
      gapSeconds: number;
      viaDeepLink: boolean;
    }
  | { name: "drift_shown"; at: string; sessionId: string; driftType: string; deltaCents: number }
  | { name: "drift_accepted"; at: string; sessionId: string; deltaCents: number }
  | { name: "completion_started"; at: string; sessionId: string; surface: Surface }
  | {
      name: "completion_succeeded";
      at: string;
      sessionId: string;
      surface: Surface;
      orderId: string;
      totalCents: number;
      /** 1 = single-surface purchase, 2 = the fan switched devices mid-checkout. */
      surfaceCount: number;
    }
  | { name: "completion_failed"; at: string; sessionId: string; code: string; retryable: boolean }
  | {
      name: "completion_blocked_duplicate";
      at: string;
      sessionId: string;
      surface: Surface;
      heldBySurface: Surface;
    }
  | { name: "session_expired"; at: string; sessionId: string; surfaceCount: number };

/**
 * Returned by `GET /api/analytics/funnel`.
 *
 * Splitting conversion by single- vs multi-surface is the whole point: a
 * cross-device checkout is one that survived an interruption, and comparing the
 * two rates is what tells you whether continuity earns its complexity.
 */
export interface Funnel {
  created: number;
  /**
   * Resume *events*, which includes a fan returning to the surface they left.
   * A useful volume number and the wrong denominator for anything: one session
   * can resume many times, and most resumes are same-surface.
   */
  resumed: number;
  /** Cross-surface resume events. Same caveat: events, not sessions. */
  resumedCrossSurface: number;
  /**
   * Distinct sessions that reached a second surface — the denominator the
   * continuity rate actually wants, since the question is "of the fans who
   * switched devices, how many bought?" and a fan is a session, not an event.
   */
  handedOffSessions: number;
  driftShown: number;
  driftAccepted: number;
  completed: number;
  failed: number;
  expired: number;
  duplicatesBlocked: number;

  singleSurface: ConversionRate;
  multiSurface: ConversionRate;

  /** Null until at least one session has been resumed. */
  medianResumeGapSeconds: number | null;
}

export interface ConversionRate {
  completed: number;
  total: number;
  rate: number;
}
