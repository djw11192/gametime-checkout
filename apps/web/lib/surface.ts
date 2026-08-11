import { cookies } from "next/headers";
import type { Surface } from "@gametime/contracts";

/** The browser's id, read on the server so it can go out with the first fetch. */
export async function getClientId(): Promise<string> {
  const store = await cookies();
  return store.get("gt_client")?.value ?? "anonymous";
}

/**
 * Which device is asking.
 *
 * The surface is passed in by the route rather than sniffed from the user
 * agent, so the same session can be opened as desktop at `/checkout/…` and as
 * mobile at `/m/checkout/…` — including both at once on one laptop.
 */
export async function clientContext(surface: Surface, viaDeepLink = false) {
  return { surface, clientId: await getClientId(), viaDeepLink };
}
