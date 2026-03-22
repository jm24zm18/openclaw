import { defineConfig } from "vitest/config";

// Node-only tests for pure logic (no Patchright/browser dependency).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    include: ["src/**/*.node.test.ts"],
    environment: "node",
  },
});
