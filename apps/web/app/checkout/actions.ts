/**
 * Every checkout action is reachable as a plain form POST, so a fan can accept
 * a price change and complete a purchase even with JavaScript disabled, or
 * simply not loaded yet.
 *
 * That is also why the forms carry an `idempotencyKey` generated on the server:
 * with no JavaScript there is no button to disable, so a double-click sends the
 * request twice — and both times with the same key, which the API treats as one
 * request.
 */
"use server";

import { revalidatePath } from "next/cache";
import { SurfaceSchema, type Surface } from "@gametime/contracts";
import { ApiClientError, acknowledgeQuote, completeCheckout, extendSession } from "@/lib/api";
import { getClientId } from "@/lib/surface";
import type { ActionState } from "./action-state";

const surfaceOf = (formData: FormData): Surface =>
  SurfaceSchema.catch("web").parse(formData.get("surface"));

const pathFor = (surface: Surface, sessionId: string) =>
  surface === "mobile" ? `/m/checkout/${sessionId}` : `/checkout/${sessionId}`;

function toState(error: unknown): ActionState {
  return {
    status: "error",
    message:
      error instanceof ApiClientError ? error.message : "Something went wrong. Please try again.",
  };
}

export async function completeCheckoutAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const sessionId = String(formData.get("sessionId"));
  const surface = surfaceOf(formData);

  try {
    const result = await completeCheckout(
      sessionId,
      {
        quoteHash: String(formData.get("quoteHash")),
        surface,
        clientId: await getClientId(),
      },
      String(formData.get("idempotencyKey")),
    );
    revalidatePath(pathFor(surface, sessionId));

    // A declined card or processor error comes back as a 200 with no order:
    // the API settled the session rather than throwing, since a retryable
    // refusal leaves the checkout active. Surface it the same as a thrown
    // error so the fan sees why nothing happened.
    const failure = result.session.session.completion?.failure;
    if (!result.order && failure) {
      return { status: "error", message: failure.message };
    }
    return { status: "ok" };
  } catch (error) {
    // A refusal here is not really an error: it is the API telling the fan
    // something true and useful, like "the price moved". Show it as state and
    // revalidate so they see the current view alongside it.
    revalidatePath(pathFor(surface, sessionId));
    return toState(error);
  }
}

export async function acknowledgeQuoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const sessionId = String(formData.get("sessionId"));
  const surface = surfaceOf(formData);

  try {
    await acknowledgeQuote(sessionId, {
      quoteHash: String(formData.get("quoteHash")),
      surface,
      clientId: await getClientId(),
    });
    revalidatePath(pathFor(surface, sessionId));
    return { status: "ok" };
  } catch (error) {
    revalidatePath(pathFor(surface, sessionId));
    return toState(error);
  }
}

export async function extendSessionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const sessionId = String(formData.get("sessionId"));
  const surface = surfaceOf(formData);

  try {
    await extendSession(sessionId, { surface, clientId: await getClientId() });
    revalidatePath(pathFor(surface, sessionId));
    return { status: "ok" };
  } catch (error) {
    return toState(error);
  }
}
