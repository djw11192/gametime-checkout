import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "gt_client";

/**
 * Gives every browser a stable id.
 *
 * A cookie rather than `sessionStorage` because the server needs it while
 * rendering: the very first render already tells the API which device is
 * looking, and a value only readable in the browser would arrive too late.
 *
 * This is not authentication. It exists only to tell two devices apart, so
 * "completing on your other device" can be true.
 */
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

// `api` is excluded so proxied calls skip this middleware entirely — above all
// the update stream, which stays open for the life of the page.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
