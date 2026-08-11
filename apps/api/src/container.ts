import { EXPIRY_SWEEP_INTERVAL_MS } from "@gametime/contracts";
import { ConsoleAnalyticsSink, type AnalyticsSink } from "./ports/analytics";
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
 * Where every dependency is wired together. Keeping it in one place is what
 * lets a test swap in a `FakeClock` or a fake payment provider without any
 * production code knowing tests exist.
 */
export interface Container {
  clock: Clock;
  inventory: InMemoryInventoryProvider;
  payments: FakePaymentProvider;
  analytics: AnalyticsSink;
  sessions: InMemorySessionStore;
  orders: InMemoryOrderStore;
  bus: SessionEventBus;
  checkout: CheckoutService;
  startSweeper(): () => void;
}

export function createContainer(
  options: { clock?: Clock; analytics?: AnalyticsSink; unlimitedInventoryListingIds?: string[] } = {},
): Container {
  const clock = options.clock ?? new SystemClock();
  const inventory = new InMemoryInventoryProvider(new Set(options.unlimitedInventoryListingIds));
  const payments = new FakePaymentProvider();
  const analytics = options.analytics ?? new ConsoleAnalyticsSink();
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
     * Two jobs on one timer: expire sessions whose deadline has passed, then
     * delete the ones that finished long enough ago. Returns a stop function so
     * tests and hot reload do not leak intervals.
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
