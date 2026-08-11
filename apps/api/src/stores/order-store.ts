import type { Order } from "@gametime/contracts";

export class DuplicateOrderError extends Error {
  constructor(readonly existingOrderId: string) {
    super(`session already has order ${existingOrderId}`);
  }
}

/**
 * Orders, with one hard rule: at most one order per session. In Postgres this
 * would be `UNIQUE (session_id)`, and the throw below stands in for the
 * database rejecting the insert.
 *
 * This is the last guard against a duplicate order (see `completeSession`) and
 * the only one a caller cannot skip or get wrong.
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
