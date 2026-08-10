import { randomUUID } from "node:crypto";
import type { PaymentMode } from "@gametime/contracts";

/**
 * Real payments are out of scope; what matters is the shape. `pending` is here
 * because authorization is not always synchronous (3DS, bank holds), and a model
 * that cannot express "we don't know yet" eventually double-charges. `void` is
 * here because authorizing is not the last thing that can fail — on a
 * marketplace with no inventory hold the seats can go while we are at the bank.
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
  private voided = new Set<string>();

  setMode(mode: PaymentMode, latencyMs?: number): void {
    this.mode = mode;
    this.latencyMs = latencyMs ?? (mode === "slow" ? 4_000 : 0);
  }

  getMode(): PaymentMode {
    return this.mode;
  }

  /** So tests can assert that a failed purchase did not leave money held. */
  voidCount(): number {
    return this.voided.size;
  }

  reset(): void {
    this.mode = "approve";
    this.latencyMs = 0;
    this.voided.clear();
  }

  async authorize(_input: {
    amountCents: number;
    idempotencyKey: string;
  }): Promise<AuthorizationResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    switch (this.mode) {
      case "decline":
        return { status: "declined", reason: "Card was declined by the issuer" };
      case "error":
        return { status: "error", reason: "Payment processor unavailable" };
      case "pending":
        return { status: "pending", authorizationId: `auth_${randomUUID().slice(0, 12)}` };
      default:
        return { status: "authorized", authorizationId: `auth_${randomUUID().slice(0, 12)}` };
    }
  }

  async void(authorizationId: string): Promise<void> {
    this.voided.add(authorizationId);
  }
}
