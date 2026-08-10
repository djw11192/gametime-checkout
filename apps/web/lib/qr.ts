import "server-only";
import QRCode from "qrcode";

const SIZE_PX = 108;

/**
 * Render a QR as an inline SVG string, on the server, so the code is part of the
 * initial HTML: no client library in the bundle, no canvas, no extra request,
 * and a fan can scan it off a page that has not hydrated yet.
 */
export async function qrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 0,
    width: SIZE_PX,
  });

  // The library emits a `viewBox`-driven SVG that fills its container; pin it so
  // the code stays a scannable size regardless of where it is placed.
  return svg.replace(/<svg /, `<svg style="width:${SIZE_PX}px;height:${SIZE_PX}px;display:block" `);
}
