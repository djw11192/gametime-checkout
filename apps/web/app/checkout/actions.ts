"use server";

import { revalidatePath } from "next/cache";
import { SurfaceSchema, type Surface } from "@gametime/contracts";
import { ApiClientError, acknowledgeQuote, completeCheckout, extendSession } from "@/lib/api";
import { getClientId } from "@/lib/surface";
import type { ActionState } from "./action-state";

/**
 * Every checkout mutation is reachable as a plain form POST. With JavaScript
 * disabled — or simply not yet executed — the fan can still accept a price
 * change and complete a purchase. The client components layer pending states on
 * top, but nothing essential depends on them.
 *
 * It is also why the forms carry a server-generated `idempotencyKey`: with no
 * JS there is no button to disable, so an impatient double-click posts twice —
 * and both posts carry the same key.
 */

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
    await completeCheckout(
      sessionId,
      {
        quoteHash: String(formData.get("quoteHash")),
        surface,
        clientId: await getClientId(),
      },
      String(formData.get("idempotencyKey")),
    );
    revalidatePath(pathFor(surface, sessionId));
    return { status: "ok" };
  } catch (error) {
    // A 409 is not an exception in the UI sense — it is the system telling the
    // fan something true and actionable ("the price moved", "your phone is
    // finishing this"). Surface it as state and revalidate to the fresh view.
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
