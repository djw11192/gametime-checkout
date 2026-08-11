import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Deliberately no fake browser environment. These tests are about what the
 * server renders — the HTML a fan sees before any JavaScript runs — so they go
 * through `react-dom/server` in plain Node.
 *
 * In a browser environment these tests could pass while the server still sent
 * an empty page, which is exactly what they exist to catch.
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
