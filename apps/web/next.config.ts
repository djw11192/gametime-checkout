import type { NextConfig } from "next";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  // The contracts package ships TypeScript source rather than a build step.
  transpilePackages: ["@gametime/contracts"],

  /**
   * Proxy browser-side API calls to Express so everything the browser touches
   * is same-origin.
   *
   * This is what makes the QR code work. The QR encodes whatever host the page
   * was served from, so tunnelling through ngrok (or just using the LAN IP)
   * already points a phone at the right web server — but the phone would then
   * try to reach the API at `localhost:4000`, which on a handset is the handset.
   * Routing through the Next origin means one tunnel is enough, and CORS stops
   * being a consideration at all.
   *
   * Server-side rendering still calls Express directly, so SSR skips this hop.
   */
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_BASE}/api/:path*` }];
  },
};

export default config;
