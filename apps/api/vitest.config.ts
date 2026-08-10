import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite is deliberately sleep-free: every time-dependent behaviour is
    // driven through the injectable Clock, so the whole thing runs in ms.
    testTimeout: 5_000,
  },
});
