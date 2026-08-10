import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

/**
 * The deep-link entry point, standing in for a universal link. Forwards to the
 * simulated mobile surface, tagging the visit so the API can tell a deep-link
 * resume from ordinary navigation.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  redirect(`/m/checkout/${sessionId}?src=deeplink`);
}
