import { describe, expect, it, vi } from "vitest";
import {
  SSE_BUFFER_SIZE,
  type CheckoutSessionView,
  type SseEnvelope,
} from "@gametime/contracts";
import { SessionEventBus } from "./event-bus";

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
    // Each session numbers its own events, so an id only means something
    // within one session.
    expect(bus.publish("sess_2", "session.updated", view(1)).id).toBe(1);
  });

  it("replays only what a reconnecting client missed", () => {
    // The locked-phone case: the connection drops, three things happen, then
    // the screen comes back on and the browser reconnects asking for whatever
    // it missed.
    const bus = new SessionEventBus();
    bus.publish("sess_1", "session.updated", view(1));
    bus.publish("sess_1", "quote.changed", view(2));
    bus.publish("sess_1", "session.updated", view(3));

    const received: SseEnvelope[] = [];
    bus.subscribe("sess_1", (envelope) => received.push(envelope), 1);

    expect(received.map((e) => e.id)).toEqual([2, 3]);
    expect(received.map((e) => e.view.session.version)).toEqual([2, 3]);
  });

  it("bounds the buffer so a long-lived session cannot leak memory", () => {
    const bus = new SessionEventBus();
    for (let i = 0; i < SSE_BUFFER_SIZE + 25; i++) {
      bus.publish("sess_1", "session.updated", view(i + 1));
    }

    const received: SseEnvelope[] = [];
    bus.subscribe("sess_1", (e) => received.push(e), 0);

    expect(received).toHaveLength(SSE_BUFFER_SIZE);
    // Fallen further behind than the buffer holds: it still gets a full copy of
    // the current state, so it recovers rather than staying quietly out of date.
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
