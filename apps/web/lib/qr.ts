import "server-only";
import QRCode from "qrcode";

const SIZE_PX = 108;

/**
 * Build a QR code as an SVG string on the server, so it is part of the initial
 * HTML. Nothing is added to the JavaScript bundle, and the code is scannable
 * before the page has finished loading.
 */
export async function qrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 0,
    width: SIZE_PX,
  });

  // The library returns an SVG that stretches to fill its container. Pin the
  // size so the code stays scannable wherever it is placed.
  return svg.replace(/<svg /, `<svg style="width:${SIZE_PX}px;height:${SIZE_PX}px;display:block" `);
}
