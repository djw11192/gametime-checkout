import path from "node:path";
import type { NextConfig } from "next";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  // The contracts package ships TypeScript source rather than a build step.
  transpilePackages: ["@gametime/contracts"],

  // A stray lockfile in a parent directory (outside this repo) makes Next
  // guess the wrong workspace root, which breaks pnpm's symlinked
  // node_modules resolution for the dev server. Pin it to the actual
  // monorepo root instead of guessing.
  outputFileTracingRoot: path.join(__dirname, "../.."),

  /**
   * Forward API calls made from the browser to Express, so everything the
   * browser requests comes from the same address as the page.
   *
   * This is what makes the QR code work. Without it a phone that scanned the
   * code would try `localhost:4000` and reach itself. Server-side calls go
   * straight to Express and skip this.
   */
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_BASE}/api/:path*` }];
  },
};

export default config;
