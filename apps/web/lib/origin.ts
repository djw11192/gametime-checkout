import "server-only";
import { headers } from "next/headers";

/**
 * The address a scanned QR code should point at.
 *
 * Defaults to whatever host served this page, so opening the app at the
 * laptop's network address makes the QR work on a phone with no configuration.
 * Set `PUBLIC_ORIGIN` to override it when the address the phone should use is
 * not the one you are browsing on.
 */
export async function publicOrigin(): Promise<string> {
  const override = process.env.PUBLIC_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");

  const headerList = await headers();
  // Each proxy appends to this header rather than replacing it, so the first
  // value is the one the client actually used.
  const proto = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = headerList.get("host") ?? `localhost:3000`;
  return `${proto}://${host}`;
}
