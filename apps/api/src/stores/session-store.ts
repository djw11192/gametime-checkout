import { isTerminal, type CheckoutSession } from "@gametime/contracts";

export type CasResult =
  | { ok: true; session: CheckoutSession }
  | { ok: false; reason: "version_conflict" | "not_found" };

/**
 * Shaped so swapping in Redis is mechanical: `get` → GET, `putIfVersion` → a Lua
 * CAS, `scanExpired` → ZRANGEBYSCORE on an expiry index. Async even though
 * nothing here awaits, so no caller can be written to depend on it being sync.
 */
export interface SessionStore {
  get(id: string): Promise<CheckoutSession | null>;
  insert(session: CheckoutSession): Promise<void>;
  putIfVersion(next: CheckoutSession, expectedVersion: number): Promise<CasResult>;
  scanExpired(nowMs: number): Promise<CheckoutSession[]>;
  /** Terminal and untouched since `beforeMs` — safe to forget. */
  scanReapable(beforeMs: number): Promise<CheckoutSession[]>;
  delete(id: string): Promise<void>;
  all(): Promise<CheckoutSession[]>;
  clear(): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, CheckoutSession>();

  async get(id: string): Promise<CheckoutSession | null> {
    const found = this.sessions.get(id);
    // Hand out a copy: callers build the next state by spreading, and a shared
    // reference would let a half-built mutation leak into a concurrent read.
    return found ? { ...found } : null;
  }

  async insert(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  /**
   * The linchpin of duplicate-order prevention. Single-threaded is not the same
   * as atomic: a handler that reads a session, awaits a payment call, then
   * writes it back has yielded the event loop in between, and a second request
   * interleaves exactly there.
   *
   * What makes this safe is that the compare and the write happen in one
   * synchronous turn — no `await` between reading `version` and calling `set`.
   * Callers may yield as much as they like beforehand.
   */
  async putIfVersion(next: CheckoutSession, expectedVersion: number): Promise<CasResult> {
    const current = this.sessions.get(next.id);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };

    const committed = { ...next, version: expectedVersion + 1 };
    this.sessions.set(next.id, committed);
    return { ok: true, session: { ...committed } };
  }

  async scanExpired(nowMs: number): Promise<CheckoutSession[]> {
    return [...this.sessions.values()].filter(
      (s) => s.status === "active" && new Date(s.expiresAt).getTime() <= nowMs,
    );
  }

  async scanReapable(beforeMs: number): Promise<CheckoutSession[]> {
    return [...this.sessions.values()].filter(
      (s) => isTerminal(s.status) && new Date(s.updatedAt).getTime() <= beforeMs,
    );
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async all(): Promise<CheckoutSession[]> {
    return [...this.sessions.values()];
  }

  async clear(): Promise<void> {
    this.sessions.clear();
  }
}
