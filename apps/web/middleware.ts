import { NextResponse, type NextRequest } from "next/server";

/**
 * Ensures every browser carries a stable client identifier.
 *
 * It lives in a cookie rather than `sessionStorage` because Server Components
 * need it during SSR — the very first render already tells the API which
 * surface is looking, and a value only readable after hydration would arrive
 * too late to be part of the initial fetch.
 *
 * This is not authentication — it exists only to tell two devices apart, so
 * "completing on your other device" can be true.
 */
const COOKIE = "gt_client";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  if (!request.cookies.get(COOKIE)) {
    response.cookies.set(COOKIE, crypto.randomUUID().slice(0, 12), {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
  }

  return response;
}

// `api` is excluded so proxied calls — especially the long-lived SSE
// connection — skip cookie middleware entirely.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
