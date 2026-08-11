import { createHash } from "node:crypto";

interface Entry<T> {
  fingerprint: string;
  status: "in_flight" | "completed";
  claimedAt: number;
  httpStatus?: number;
  response?: T;
}

export type ClaimResult<T> =
  | { outcome: "claimed" }
  /** Seen before and answered — replay it verbatim. */
  | { outcome: "replay"; httpStatus: number; response: T }
  /** Same key, still running: the client retried before the first attempt finished. */
  | { outcome: "in_flight" }
  /** Same key, different payload. Almost always a client bug; never silently accept it. */
  | { outcome: "mismatch" };

/**
 * Tracks `Idempotency-Key` headers so the same request can be retried safely,
 * following the same rules Stripe uses.
 *
 * The part that is easy to get wrong is `in_flight`. If the key were only
 * recorded once the work finished, a retry arriving during the slow payment
 * call would find no record and start a second charge — and that is exactly
 * when an impatient double-tap arrives. So the key is claimed up front.
 */
export class InMemoryIdempotencyStore {
  private records = new Map<string, Entry<unknown>>();

  claim<T>(key: string, payload: unknown, nowMs: number): ClaimResult<T> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload ?? null))
      .digest("hex")
      .slice(0, 16);

    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, { fingerprint, status: "in_flight", claimedAt: nowMs });
      return { outcome: "claimed" };
    }
    if (existing.fingerprint !== fingerprint) return { outcome: "mismatch" };
    if (existing.status === "in_flight") return { outcome: "in_flight" };

    return {
      outcome: "replay",
      httpStatus: existing.httpStatus ?? 200,
      response: existing.response as T,
    };
  }

  complete<T>(key: string, httpStatus: number, response: T): void {
    const existing = this.records.get(key);
    if (existing) Object.assign(existing, { status: "completed", httpStatus, response });
  }

  /**
   * Forget a key so the request can be made again. Used when a card is
   * declined: if we kept the key, every retry would replay that decline and the
   * fan would have to restart checkout just to try a different card.
   */
  release(key: string): void {
    this.records.delete(key);
  }

  /**
   * Delete keys older than the retention period. A real implementation would
   * set an expiry on each key as it is written; sweeping is the same policy
   * done from the other end.
   *
   * Claims still marked `in_flight` are deleted too. One older than the
   * retention period means the process holding it died mid-attempt, and keeping
   * it would lock that fan out of ever retrying.
   */
  expireBefore(cutoffMs: number): number {
    let dropped = 0;
    for (const [key, record] of this.records) {
      if (record.claimedAt <= cutoffMs) {
        this.records.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.records.clear();
  }
}
