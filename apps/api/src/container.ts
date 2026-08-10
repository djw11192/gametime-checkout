import { EXPIRY_SWEEP_INTERVAL_MS } from "@gametime/contracts";
import { SystemClock, type Clock } from "./ports/clock";
import { InMemoryInventoryProvider } from "./ports/inventory";
import { FakePaymentProvider } from "./ports/payment";
import { quoteFromListing } from "./ports/pricing";
import { CheckoutService } from "./services/checkout-service";
import { SessionEventBus } from "./stores/event-bus";
import { InMemoryIdempotencyStore } from "./stores/idempotency-store";
import { InMemoryOrderStore } from "./stores/order-store";
import { InMemorySessionStore } from "./stores/session-store";

/**
 * Composition root. Everything is wired here, which is what lets the tests swap
 * in a `FakeClock` without production code knowing tests exist.
 */
export interface Container {
  clock: Clock;
  inventory: InMemoryInventoryProvider;
  payments: FakePaymentProvider;
  sessions: InMemorySessionStore;
  orders: InMemoryOrderStore;
  bus: SessionEventBus;
  checkout: CheckoutService;
  startSweeper(): () => void;
}

export function createContainer(options: { clock?: Clock } = {}): Container {
  const clock = options.clock ?? new SystemClock();
  const inventory = new InMemoryInventoryProvider();
  const payments = new FakePaymentProvider();
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
    quoteListing: quoteFromListing,
    payments,
    clock,
  });

  return {
    clock,
    inventory,
    payments,
    sessions,
    orders,
    bus,
    checkout,

    /**
     * Two jobs on one timer: expire elapsed sessions so open tabs find out, then
     * forget the ones finished long enough that nobody is coming back. Returns a
     * stop function so tests and hot reload don't leak intervals.
     */
    startSweeper() {
      const handle = setInterval(() => {
        // An unhandled rejection on a timer takes the process down, and a failed
        // background tick is not a reason to stop serving checkouts.
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
  };
}
