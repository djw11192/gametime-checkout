/**
 * The state contract the checkout Server Actions return to `useActionState`.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export async
 * functions — the compiler turns every export into a callable RPC endpoint, and
 * a constant cannot be one.
 */
export interface ActionState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export const IDLE: ActionState = { status: "idle" };
