import { EXPIRY_SWEEP_INTERVAL_MS } from "@gametime/contracts";
import { InMemoryAnalyticsSink } from "./ports/analytics";
import { SystemClock, type Clock } from "./ports/clock";
import { InMemoryInventoryProvider } from "./ports/inventory";
import { FakePaymentProvider } from "./ports/payment";
import { MarketplacePricingProvider } from "./ports/pricing";
import { CheckoutService } from "./services/checkout-service";
import { SessionEventBus } from "./stores/event-bus";
import { InMemoryIdempotencyStore } from "./stores/idempotency-store";
import { InMemoryOrderStore } from "./stores/order-store";
import { InMemorySessionStore } from "./stores/session-store";

/**
 * Composition root. Everything is wired here and nowhere else, which is what
 * lets the test suite swap in a `FakeClock` without production code knowing
 * tests exist.
 */
export interface Container {
  clock: Clock;
  inventory: InMemoryInventoryProvider;
  payments: FakePaymentProvider;
  analytics: InMemoryAnalyticsSink;
  sessions: InMemorySessionStore;
  orders: InMemoryOrderStore;
  bus: SessionEventBus;
  checkout: CheckoutService;
  startSweeper(): () => void;
  reset(): Promise<void>;
}

export function createContainer(options: { clock?: Clock } = {}): Container {
  const clock = options.clock ?? new SystemClock();
  const inventory = new InMemoryInventoryProvider();
  const pricing = new MarketplacePricingProvider(inventory);
  const payments = new FakePaymentProvider();
  const analytics = new InMemoryAnalyticsSink();
  const sessions = new InMemorySessionStore();
  const orders = new InMemoryOrderStore();
  const idempotency = new InMemoryIdempotencyStore();
  const bus = new SessionEventBus();

  const checkout = new CheckoutService({
    sessions,
    orders,
    idempotency,
    bus,
    inventory,
    pricing,
    payments,
    analytics,
    clock,
  });

  return {
    clock,
    inventory,
    payments,
    analytics,
    sessions,
    orders,
    bus,
    checkout,

    /**
     * Two jobs on one timer: turn elapsed sessions into an event so open tabs
     * find out, then forget the ones that have been finished long enough that
     * nobody is coming back. Returns a stop function so tests and hot reload
     * don't leak intervals.
     */
    startSweeper() {
      const handle = setInterval(() => {
        // Caught rather than left to float: an unhandled rejection on a timer
        // takes the process down, and a background tick failing is not a reason
        // to stop serving checkouts.
        void (async () => {
          try {
            await checkout.sweepExpired();
            await checkout.reapTerminal();
          } catch (error) {
            console.error("[sweeper]", error);
          }
        })();
      }, EXPIRY_SWEEP_INTERVAL_MS);
      handle.unref?.();
      return () => clearInterval(handle);
    },

    /**
     * Resets the marketplace, not the measurement. Analytics is an append-only
     * record of what happened; wiping it because the seed data reloaded would
     * make the funnel meaningless across a multi-scenario run.
     */
    async reset() {
      inventory.reset();
      payments.reset();
      await sessions.clear();
      orders.clear();
      idempotency.clear();
      bus.clear();
    },
  };
}
