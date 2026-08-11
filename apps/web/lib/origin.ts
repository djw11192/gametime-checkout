import "server-only";
import { cookies, headers } from "next/headers";

const ORIGIN_COOKIE = "gt_origin";
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

async function originFromHeaders(): Promise<string> {
  const headerList = await headers();
  // Each proxy appends to this header rather than replacing it, so the first
  // value is the one the client actually used.
  const proto = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = headerList.get("host") ?? `localhost:3000`;
  return `${proto}://${host}`;
}

/**
 * The address a scanned QR code should point at.
 *
 * Defaults to whatever host served this page, so opening the app at the
 * laptop's network address makes the QR work on a phone with no configuration.
 * Set `PUBLIC_ORIGIN` to override it when the address the phone should use is
 * not the one you are browsing on.
 *
 * One case the `host` header lies: when a Server Action redirects (creating a
 * checkout does), Next renders the destination itself via a loopback request
 * to `localhost`, rather than a request from the fan's browser. `rememberOrigin`
 * catches the real address before that happens; if it left a note, trust it
 * over a `host` header that claims to be the loopback address.
 */
export async function publicOrigin(): Promise<string> {
  const override = process.env.PUBLIC_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");

  const origin = await originFromHeaders();
  const host = origin.replace(/^[a-z]+:\/\//, "");
  if (LOOPBACK_HOST.test(host)) {
    const remembered = (await cookies()).get(ORIGIN_COOKIE)?.value;
    if (remembered) return remembered;
  }
  return origin;
}

/**
 * Snapshots the real request origin so a Server Action's `redirect()` can
 * recover it. Call this before redirecting from an action that a fan might
 * reach over the local network rather than `localhost`.
 */
export async function rememberOrigin(): Promise<void> {
  const origin = await originFromHeaders();
  (await cookies()).set(ORIGIN_COOKIE, origin, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
}
