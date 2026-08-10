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
 * `Idempotency-Key` bookkeeping, following Stripe's semantics.
 *
 * The subtle requirement is `in_flight`. Recording the key only *after* the work
 * finishes leaves a window during the slow payment call where a retry sees no
 * record and starts a second authorization — which is exactly the window an
 * impatient double-tap lands in. So the key is claimed before the work starts.
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
   * Drop a claim so the operation can be attempted again — used when a card is
   * declined. Keeping it would pin the fan to the declined result forever, and
   * they would have to restart checkout to try another card.
   */
  release(key: string): void {
    this.records.delete(key);
  }

  /**
   * Forget keys older than the retention window. Real implementations give the
   * key a TTL on write; this is the same policy expressed as a sweep. In-flight
   * records go too — one older than the window means the process that claimed it
   * died mid-attempt, and holding it would lock that fan out of retrying.
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
