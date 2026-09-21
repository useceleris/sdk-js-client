import { defineConfig } from "vitest/config";

// Celeris acceptance suites run against a real server and stay separate
// from the local evidence in vitest.config.ts. See docs/testing.md.
export default defineConfig({
  test: {
    include: ["tests/celeris/**/*.test.ts"],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
