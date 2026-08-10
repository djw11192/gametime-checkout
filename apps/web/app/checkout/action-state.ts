/**
 * The state contract the checkout Server Actions return to `useActionState`.
 *
 * Deliberately not in `actions.ts`: a `"use server"` module may only export
 * async functions, because the compiler turns every export into a callable RPC
 * endpoint and a constant cannot be one. Keeping the shape and its initial value
 * in a plain module lets both the actions and the client forms import them
 * without the actions file having to smuggle a value past that rule.
 */
export interface ActionState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export const IDLE: ActionState = { status: "idle" };
