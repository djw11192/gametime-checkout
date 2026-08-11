import { qrSvg } from "@/lib/qr";
import { Card } from "@/components/ui";

/**
 * The QR code that moves a checkout from this device to a phone.
 *
 * `/link/{id}` is a normal HTTPS URL, the kind a native app would claim for
 * itself and which falls back to the web when the app is not installed.
 * `origin` comes from `publicOrigin()` so the code points at an address the
 * phone can actually reach, rather than at the laptop's own `localhost`.
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
          // Safe: this SVG is built from a URL we construct ourselves, and the
          // only part that varies is a uuid we generated.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="min-w-0 text-xs text-slate-500">
          <p>
            Works on a real phone on the same network — the QR encodes{" "}
            <code className="font-mono">{origin}</code>.
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
