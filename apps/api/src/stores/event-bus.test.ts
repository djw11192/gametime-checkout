import { describe, expect, it, vi } from "vitest";
import {
  SSE_BUFFER_SIZE,
  mergeSessionView,
  type CheckoutSessionView,
  type SseEnvelope,
} from "@gametime/contracts";
import { SessionEventBus } from "./event-bus";

/**
 * `serverTime` is an explicit parameter rather than `Date.now()`: it is half of
 * the merge ordering, so a fixture that stamps the wall clock makes the tests
 * below assert whatever the scheduler happened to do.
 */
const T0 = "2026-01-01T00:00:00.000Z";
const at = (secondsAfterT0: number) =>
  new Date(Date.parse(T0) + secondsAfterT0 * 1000).toISOString();

function view(version: number, serverTime = T0): CheckoutSessionView {
  return {
    session: { version } as CheckoutSessionView["session"],
    liveQuote: null,
    drift: [],
    remainingMs: 60_000,
    serverTime,
    canComplete: true,
    blockers: [],
  };
}

describe("SessionEventBus", () => {
  it("delivers to every subscriber on the session and nobody else", () => {
    const bus = new SessionEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();

    bus.subscribe("sess_1", a);
    bus.subscribe("sess_1", b);
    bus.subscribe("sess_2", other);

    bus.publish("sess_1", "session.updated", view(1));

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("numbers events monotonically per session", () => {
    const bus = new SessionEventBus();
    const ids = [
      bus.publish("sess_1", "session.updated", view(1)).id,
      bus.publish("sess_1", "quote.changed", view(2)).id,
      bus.publish("sess_1", "session.expired", view(3)).id,
    ];
    expect(ids).toEqual([1, 2, 3]);
    // Each session numbers independently — ids are only meaningful per channel.
    expect(bus.publish("sess_2", "session.updated", view(1)).id).toBe(1);
  });

  it("replays only what a reconnecting client missed", () => {
    // The lock-screen case: the phone drops the connection, three things happen,
    // the screen comes back on and EventSource reconnects with Last-Event-ID.
    const bus = new SessionEventBus();
    bus.publish("sess_1", "session.updated", view(1));
    bus.publish("sess_1", "quote.changed", view(2));
    bus.publish("sess_1", "session.updated", view(3));

    const received: SseEnvelope[] = [];
    bus.subscribe("sess_1", (envelope) => received.push(envelope), 1);

    expect(received.map((e) => e.id)).toEqual([2, 3]);
    expect(received.map((e) => e.view.session.version)).toEqual([2, 3]);
  });

  it("replays nothing when the client is already current", () => {
    const bus = new SessionEventBus();
    bus.publish("sess_1", "session.updated", view(1));

    const received: SseEnvelope[] = [];
    bus.subscribe("sess_1", (e) => received.push(e), 1);
    expect(received).toEqual([]);
  });

  it("bounds the buffer so a long-lived session cannot leak memory", () => {
    const bus = new SessionEventBus();
    for (let i = 0; i < SSE_BUFFER_SIZE + 25; i++) {
      bus.publish("sess_1", "session.updated", view(i + 1));
    }

    const received: SseEnvelope[] = [];
    bus.subscribe("sess_1", (e) => received.push(e), 0);

    expect(received).toHaveLength(SSE_BUFFER_SIZE);
    // A client that fell further behind than the buffer still gets a full-state
    // envelope, so it self-heals rather than staying silently stale.
    expect(received.at(-1)?.view.session.version).toBe(SSE_BUFFER_SIZE + 25);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new SessionEventBus();
    const subscriber = vi.fn();
    const unsubscribe = bus.subscribe("sess_1", subscriber);

    bus.publish("sess_1", "session.updated", view(1));
    unsubscribe();
    bus.publish("sess_1", "session.updated", view(2));

    expect(subscriber).toHaveBeenCalledOnce();
    expect(bus.subscriberCount("sess_1")).toBe(0);
  });

  it("keeps delivering to healthy subscribers when one throws", () => {
    const bus = new SessionEventBus();
    const healthy = vi.fn();
    bus.subscribe("sess_1", () => {
      throw new Error("socket already closed");
    });
    bus.subscribe("sess_1", healthy);

    expect(() => bus.publish("sess_1", "session.updated", view(1))).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });
});

describe("mergeSessionView (the client-side staleness guard)", () => {
  it("accepts a strictly newer version", () => {
    expect(mergeSessionView(view(1), view(2)).session.version).toBe(2);
  });

  it("ignores an out-of-order view that would move state backwards", () => {
    // The failure this prevents: a late envelope walking a completed checkout
    // back to `active`, turning the fan's confirmation into a buy button again.
    expect(mergeSessionView(view(9), view(3)).session.version).toBe(9);
  });

  it("takes the incoming view when there is nothing cached", () => {
    expect(mergeSessionView(undefined, view(1)).session.version).toBe(1);
  });

  it("ignores the exact envelope the client already applied", () => {
    const replayed = view(5, at(10));
    expect(mergeSessionView(view(5, at(10)), replayed)).not.toBe(replayed);
  });

  /**
   * The regression. A price change is not a session mutation — the fan's
   * agreement is untouched, so `version` does not move — but the projection
   * around it does. Ordering on version alone dropped this frame, which meant
   * `quote.changed` never reached an open surface and the drift banner only
   * ever appeared on a fresh server render.
   */
  it("accepts a re-projection at the same version (quote.changed)", () => {
    const cached = view(4, at(0));
    const repriced: CheckoutSessionView = {
      ...view(4, at(30)),
      drift: [{ type: "price_increased", deltaCents: 2000, fromCents: 53000, toCents: 55000 }],
      canComplete: false,
      blockers: ["quote_unacknowledged"],
    };

    const merged = mergeSessionView(cached, repriced);

    expect(merged.canComplete).toBe(false);
    expect(merged.drift).toHaveLength(1);
  });

  it("ignores a replayed projection older than the one already applied", () => {
    const merged = mergeSessionView(view(4, at(30)), view(4, at(0)));
    expect(merged.serverTime).toBe(at(30));
  });

  it("prefers a real mutation over a newer projection of the older state", () => {
    // Time is only the tiebreak. A stale-timestamped view at a higher version
    // still wins, because a version bump means the stored session changed.
    expect(mergeSessionView(view(4, at(99)), view(5, at(1))).session.version).toBe(5);
  });

  it("is idempotent under repeated replay of the same batch", () => {
    const batch = [view(2, at(2)), view(3, at(3)), view(4, at(4))];
    let state = view(1, at(1));
    for (const round of [0, 1, 2]) {
      void round;
      for (const incoming of batch) state = mergeSessionView(state, incoming);
    }
    expect(state.session.version).toBe(4);
    expect(state.serverTime).toBe(at(4));
  });
});
