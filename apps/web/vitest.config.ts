import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * No jsdom. These tests are about what the *server* renders — the HTML a fan
 * has in front of them before any JavaScript executes — so they run through
 * `react-dom/server` in plain Node. A browser environment would let a passing
 * test coexist with a blank first paint, which is the thing being guarded.
 */
export default defineConfig({
  esbuild: {
    // The app's tsconfig says `preserve` because Next compiles the JSX; here
    // esbuild has to actually transform it.
    jsx: "automatic",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
