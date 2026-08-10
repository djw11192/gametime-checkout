import { randomUUID } from "node:crypto";
import type { PaymentMode } from "@gametime/contracts";

/**
 * Real payments are out of scope, so the value here is the *shape*:
 *
 *  - it takes an idempotency key, because every real PSP does, and that key is
 *    what makes a network retry safe;
 *  - it can return `pending`, because authorization is not always synchronous
 *    (3DS, bank holds) and a state model that cannot express "we don't know
 *    yet" will eventually double-charge someone;
 *  - declines are distinct from errors: one is the fan's problem, one is ours;
 *  - a successful authorization hands back an id, and there is a `void`, because
 *    authorizing is not the last thing that can fail. On a marketplace that
 *    holds no inventory, the seats can go while we are talking to the bank, and
 *    a checkout that has no way to say "never mind" leaves a real hold on a real
 *    card belonging to someone who got nothing.
 */
export type AuthorizationResult =
  | { status: "authorized"; authorizationId: string }
  | { status: "pending"; authorizationId: string }
  | { status: "declined"; reason: string }
  | { status: "error"; reason: string };

export interface PaymentProvider {
  authorize(input: { amountCents: number; idempotencyKey: string }): Promise<AuthorizationResult>;
  /** Release a hold we are not going to capture. Must be safe to call twice. */
  void(authorizationId: string): Promise<void>;
}

export class FakePaymentProvider implements PaymentProvider {
  private mode: PaymentMode = "approve";
  private latencyMs = 0;
  private byKey = new Map<string, AuthorizationResult>();
  private voided = new Set<string>();

  setMode(mode: PaymentMode, latencyMs?: number): void {
    this.mode = mode;
    this.latencyMs = latencyMs ?? (mode === "slow" ? 4_000 : 0);
  }

  getMode(): PaymentMode {
    return this.mode;
  }

  /** So tests can assert that a failed purchase did not leave money held. */
  wasVoided(authorizationId: string): boolean {
    return this.voided.has(authorizationId);
  }

  voidCount(): number {
    return this.voided.size;
  }

  reset(): void {
    this.mode = "approve";
    this.latencyMs = 0;
    this.byKey.clear();
    this.voided.clear();
  }

  async authorize(input: {
    amountCents: number;
    idempotencyKey: string;
  }): Promise<AuthorizationResult> {
    const replayed = this.byKey.get(input.idempotencyKey);
    if (replayed) return replayed;

    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const result: AuthorizationResult =
      this.mode === "decline"
        ? { status: "declined", reason: "Card was declined by the issuer" }
        : this.mode === "pending"
          ? { status: "pending", authorizationId: `auth_${randomUUID().slice(0, 12)}` }
          : this.mode === "error"
            ? { status: "error", reason: "Payment processor unavailable" }
            : { status: "authorized", authorizationId: `auth_${randomUUID().slice(0, 12)}` };

    this.byKey.set(input.idempotencyKey, result);
    return result;
  }

  async void(authorizationId: string): Promise<void> {
    this.voided.add(authorizationId);
  }
}
