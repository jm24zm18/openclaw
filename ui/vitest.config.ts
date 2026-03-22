import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.browser.test.ts"],
          exclude: ["src/**/*.node.test.ts"],
          environment: "jsdom",
        },
      }),
      defineProject({
        test: {
          name: "unit-node",
          include: ["src/**/*.node.test.ts"],
          environment: "jsdom",
        },
      }),
    ],
  },
});
