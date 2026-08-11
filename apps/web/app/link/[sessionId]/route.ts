import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

/**
 * Where a scanned QR code lands. Stands in for the kind of link a native app
 * would claim for itself, falling back to the web when it is not installed.
 *
 * The `src` tag lets the API tell a scanned link apart from ordinary browsing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  redirect(`/m/checkout/${sessionId}?src=deeplink`);
}
