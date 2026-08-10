import type { Order } from "@gametime/contracts";

export class DuplicateOrderError extends Error {
  constructor(readonly existingOrderId: string) {
    super(`session already has order ${existingOrderId}`);
  }
}

/**
 * Orders, with a uniqueness invariant on `sessionId` — in Postgres this is
 * `UNIQUE (session_id)` and the throw stands in for the constraint violation.
 *
 * This is the last of the four duplicate-prevention layers and the only true
 * invariant. The idempotency key, the CAS lock, and terminal-state idempotence
 * are all things a caller has to use correctly; this one holds even if every
 * one of them is bypassed, which is what you want from the layer standing
 * directly in front of "money moves".
 */
export class InMemoryOrderStore {
  private orders = new Map<string, Order>();
  private bySession = new Map<string, string>();

  insert(order: Order): Order {
    const existing = this.bySession.get(order.sessionId);
    if (existing) throw new DuplicateOrderError(existing);
    this.orders.set(order.id, { ...order });
    this.bySession.set(order.sessionId, order.id);
    return { ...order };
  }

  get(orderId: string): Order | null {
    return this.orders.get(orderId) ?? null;
  }

  getBySession(sessionId: string): Order | null {
    const id = this.bySession.get(sessionId);
    return id ? this.get(id) : null;
  }

  count(): number {
    return this.orders.size;
  }

  clear(): void {
    this.orders.clear();
    this.bySession.clear();
  }
}
