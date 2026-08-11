import { isTerminal, type CheckoutSession } from "@gametime/contracts";

export type CasResult =
  | { ok: true; session: CheckoutSession }
  | { ok: false; reason: "version_conflict" | "not_found" };

/**
 * Shaped so that swapping in Redis later is mechanical: `get` becomes a GET,
 * `putIfVersion` a small Lua script, `scanExpired` a range query over an index
 * of expiry times.
 *
 * Every method is async even though the in-memory version never waits on
 * anything, so no caller can accidentally be written to depend on these
 * returning immediately.
 */
export interface SessionStore {
  get(id: string): Promise<CheckoutSession | null>;
  insert(session: CheckoutSession): Promise<void>;
  putIfVersion(next: CheckoutSession, expectedVersion: number): Promise<CasResult>;
  scanExpired(nowMs: number): Promise<CheckoutSession[]>;
  /** Locked into a completion attempt that has outlived its own deadline. */
  scanStalledCompletions(nowMs: number): Promise<CheckoutSession[]>;
  /** Finished, and untouched since `beforeMs` — safe to delete. */
  scanReapable(beforeMs: number): Promise<CheckoutSession[]>;
  delete(id: string): Promise<void>;
  all(): Promise<CheckoutSession[]>;
  clear(): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, CheckoutSession>();

  async get(id: string): Promise<CheckoutSession | null> {
    const found = this.sessions.get(id);
    // Hand out a copy. Callers build the next state by spreading this one, and
    // sharing the object would let a half-finished change show up in a
    // concurrent read.
    return found ? { ...found } : null;
  }

  async insert(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  /**
   * Write the session back, but only if nobody else has written it since we
   * read it. This is the core of how duplicate orders are prevented.
   *
   * Node being single-threaded does not make this safe on its own. A handler
   * that reads a session, `await`s a payment call, then writes it back has let
   * other work run in the middle, and a second request slips in exactly there.
   *
   * What makes it safe is that the version check and the write happen with no
   * `await` between them, so nothing can run in between. Callers are free to
   * await as much as they like before calling this.
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

  /**
   * The counterpart to `scanExpired`, for the one status that no deadline
   * otherwise touches. `BEGIN_COMPLETION` pushes `expiresAt` out to cover the
   * attempt, so the same field answers "has this attempt run out of time?"
   */
  async scanStalledCompletions(nowMs: number): Promise<CheckoutSession[]> {
    return [...this.sessions.values()].filter(
      (s) => s.status === "completing" && new Date(s.expiresAt).getTime() <= nowMs,
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
