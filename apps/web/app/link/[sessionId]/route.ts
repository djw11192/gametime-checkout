import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

/**
 * The deep-link entry point.
 *
 * Stands in for a universal link / app link. In production this URL is claimed
 * by the native app via `apple-app-site-association` and `assetlinks.json`; the
 * OS opens the app if it is installed and falls through to the web if not. That
 * fallback is the reason a deep link should always be an HTTPS URL that renders
 * something useful, rather than a bare `gametime://` scheme that dead-ends for
 * anyone without the app.
 *
 * Here it forwards to the simulated mobile surface, tagging the visit so the
 * API can attribute the resume to a deep link rather than ordinary navigation.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  redirect(`/m/checkout/${sessionId}?src=deeplink`);
}
