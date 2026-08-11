/**
 * The shape the checkout Server Actions return to `useActionState`.
 *
 * In its own file because a `"use server"` module may only export async
 * functions. Every export there becomes something the browser can call over
 * the network, and a plain type or constant cannot be one.
 */
export interface ActionState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export const IDLE: ActionState = { status: "idle" };
