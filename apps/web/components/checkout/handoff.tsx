import { qrSvg } from "@/lib/qr";
import { Card } from "@/components/ui";

/**
 * The cross-device handoff. `/link/{id}` is the deep link — an HTTPS URL a
 * native app would claim, falling through to the web surface when it is not
 * installed.
 *
 * The QR is inline SVG generated on the server: no client library, no image
 * request, and scannable off a page that has not hydrated yet.
 */
export async function Handoff({ sessionId, origin }: { sessionId: string; origin: string }) {
  const linkUrl = `${origin}/link/${sessionId}`;
  const svg = await qrSvg(linkUrl);

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold">Continue on your phone</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Scan to open this exact checkout on mobile. Same seats, same price, same clock — nothing
        restarts.
      </p>

      <div className="mt-4 flex items-center gap-4">
        <div
          className="shrink-0 rounded-lg bg-white p-2 ring-1 ring-slate-200"
          // Built from a URL we construct ourselves; the only variable part is a
          // uuid we minted.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="min-w-0 text-xs text-slate-500">
          <p>
            Works on a real phone when the app is served over your LAN address or a tunnel — the QR
            encodes whichever host you loaded this page from.
          </p>
          <a
            href={`/m/checkout/${sessionId}?src=deeplink`}
            className="mt-2 inline-block font-medium text-brand-600 underline underline-offset-4"
          >
            Open the mobile view here →
          </a>
        </div>
      </div>
    </Card>
  );
}
