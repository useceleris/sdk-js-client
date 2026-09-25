import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Credentials and the target URL come from a local .env (gitignored).
// Point CELERIS_WS_URL at any stack — local or deployed — to run there.
if (existsSync(".env")) process.loadEnvFile(".env");

// Celeris acceptance suites run against a real server and stay separate
// from the local evidence in vitest.config.ts.
export default defineConfig({
  test: {
    include: ["tests/celeris/**/*.test.ts"],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
