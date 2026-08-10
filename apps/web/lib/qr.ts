import "server-only";
import QRCode from "qrcode";

/**
 * Render a QR as an inline SVG string, on the server.
 *
 * Server-side and inline so the code is part of the initial HTML: no client
 * library in the bundle, no canvas, no extra request, and a fan can scan it
 * off a page that has not hydrated yet. Given the handoff is the whole feature,
 * making it depend on JavaScript would have been an odd choice.
 */
export async function qrSvg(text: string, size = 108): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 0,
    width: size,
  });

  // The library emits its own width/height; strip them so the SVG scales with
  // its container instead of fighting the layout.
  return svg.replace(/<svg /, `<svg style="width:${size}px;height:${size}px;display:block" `);
}
