import { cookies } from "next/headers";
import type { Surface } from "@gametime/contracts";

/**
 * Who is asking, resolved on the server so it can be part of the first fetch.
 *
 * The surface is derived from the route rather than from a user agent: the
 * whole point of the prototype is that the same session renders differently on
 * `/checkout/…` and `/m/checkout/…`, and a reviewer needs to be able to open
 * both on one laptop.
 */
export async function getClientId(): Promise<string> {
  const store = await cookies();
  return store.get("gt_client")?.value ?? "anonymous";
}

export async function clientContext(surface: Surface, viaDeepLink = false) {
  return { surface, clientId: await getClientId(), viaDeepLink };
}
