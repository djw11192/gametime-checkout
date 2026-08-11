// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CheckoutSessionViewSchema, type CheckoutSessionView } from "@gametime/contracts";
import { useCheckoutSession } from "./use-checkout-session";

/**
 * The path from a pushed event to what is on screen. `mergeSessionView` decides
 * which of two views wins and is tested on its own; this covers the wiring
 * around it — that messages are parsed and applied at all, and that a stream
 * having a bad moment does not cost the fan their live updates.
 *
 * The only file here that needs a DOM, hence the environment docblock. The rest
 * of these tests are about server-rendered HTML and run in plain Node.
 */

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (secondsAfterT0: number) => new Date(T0 + secondsAfterT0 * 1000).toISOString();

function quote(pricePerTicketCents: number, hash: string) {
  const feesPerTicketCents = Math.round(pricePerTicketCents * 0.15);
  return {
    listingId: "lst_warriors_lower_112",
    quantity: 2,
    pricePerTicketCents,
    feesPerTicketCents,
    subtotalCents: pricePerTicketCents * 2,
    feesCents: feesPerTicketCents * 2,
    totalCents: (pricePerTicketCents + feesPerTicketCents) * 2,
    hash,
  };
}

/** Parsed through the real schema, so a contract change fails here rather than being mimicked. */
function view(overrides: { serverTime: string; price?: number; hash?: string }): CheckoutSessionView {
  const accepted = quote(23_000, "hash_a");
  return CheckoutSessionViewSchema.parse({
    session: {
      id: "sess_1",
      version: 1,
      status: "active",
      eventId: "evt_warriors_lakers",
      listingId: accepted.listingId,
      quantity: 2,
      acceptedQuote: accepted,
      acknowledgedQuoteHash: "hash_a",
      expiresAt: at(600),
      extensionsUsed: 0,
      origin: { surface: "web", at: at(0) },
      lastSeen: { surface: "web", at: at(0) },
      surfacesSeen: ["web"],
      completion: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
    liveQuote: quote(overrides.price ?? 23_000, overrides.hash ?? "hash_a"),
    drift: [],
    remainingMs: 540_000,
    serverTime: overrides.serverTime,
    canComplete: true,
    blockers: [],
  });
}

/* ── a controllable EventSource ───────────────────────────────────────────── */

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /* ── driven by the tests ── */

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  deliver(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>);
    }
  }

  push(type: string, pushedView: CheckoutSessionView) {
    this.deliver(type, JSON.stringify({ type, view: pushedView }));
  }

  /** `givenUp` is the difference between retrying and falling back to polling. */
  fail(givenUp: boolean) {
    this.readyState = givenUp ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

function Harness({ initialView }: { initialView: CheckoutSessionView }) {
  const { view: current, streamState } = useCheckoutSession({
    sessionId: initialView.session.id,
    initialView,
    surface: "web",
    clientId: "web-client",
  });

  return (
    <>
      <span data-testid="total">{current.liveQuote?.totalCents}</span>
      <span data-testid="stream">{streamState}</span>
    </>
  );
}

/**
 * React Query notifies its observers on a `setTimeout(0)`, so the screen is one
 * macrotask behind the cache. Every step waits for that inside `act`, which is
 * why these read as `await` rather than plain calls.
 */
const flush = (work: () => void) =>
  act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(initialView: CheckoutSessionView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness initialView={initialView} />
    </QueryClientProvider>,
  );

  const source = FakeEventSource.last!;
  await flush(() => source.open());
  return source;
}

const totalOnScreen = () => screen.getByTestId("total").textContent;
const streamOnScreen = () => screen.getByTestId("stream").textContent;

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal("EventSource", FakeEventSource);
  // The poll fallback is not what these tests are about; this stops a refetch
  // reaching a relative URL that jsdom cannot resolve.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ── tests ────────────────────────────────────────────────────────────────── */

describe("useCheckoutSession", () => {
  it("puts a pushed price change on screen", async () => {
    const source = await mount(view({ serverTime: at(10) }));
    expect(totalOnScreen()).toBe("52900");

    await flush(() =>
      source.push("quote.changed", view({ serverTime: at(40), price: 24_000, hash: "hash_b" })),
    );

    expect(totalOnScreen()).toBe("55200");
  });

  it("falls back to polling only once the stream has genuinely given up", async () => {
    // `EventSource` reconnects by itself, so an error is usually temporary.
    // Polling on the first one would abandon a stream about to recover.
    const source = await mount(view({ serverTime: at(10) }));
    expect(streamOnScreen()).toBe("live");

    await flush(() => source.fail(false));
    expect(streamOnScreen()).toBe("reconnecting");

    await flush(() => source.fail(true));
    expect(streamOnScreen()).toBe("polling");
  });

  it("keeps working after a message it cannot read", async () => {
    // One bad frame must not cost the fan every update that follows it.
    const source = await mount(view({ serverTime: at(10) }));

    await flush(() => source.deliver("quote.changed", "not json"));
    await flush(() =>
      source.push("quote.changed", view({ serverTime: at(40), price: 24_000, hash: "hash_b" })),
    );

    expect(totalOnScreen()).toBe("55200");
  });
});
