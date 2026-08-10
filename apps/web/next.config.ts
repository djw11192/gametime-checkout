import type { NextConfig } from "next";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  // The contracts package ships TypeScript source rather than a build step.
  transpilePackages: ["@gametime/contracts"],

  /**
   * Proxy browser-side API calls to Express so everything the browser touches is
   * same-origin. This is what makes the QR work: a phone that scanned it would
   * otherwise resolve `localhost:4000` to itself. SSR calls Express directly and
   * skips this hop.
   */
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_BASE}/api/:path*` }];
  },
};

export default config;
