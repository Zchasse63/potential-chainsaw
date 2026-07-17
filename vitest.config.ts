import { defineConfig } from "vitest/config";

// Root Vitest config: `pnpm -w test` runs every workspace package's tests.
export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "workers/test/**/*.test.ts",
    ],
  },
});
