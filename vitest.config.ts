import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Root Vitest config: `pnpm -w test` runs every workspace package's tests.
export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TS sources so tests run against the
    // same code `tsc -b` compiles, without requiring a prior build.
    alias: {
      "@kelo/contracts": `${root}packages/contracts/src/index.ts`,
      "@kelo/db": `${root}packages/db/src/index.ts`,
      "@kelo/workers": `${root}workers/src/index.ts`,
      "@kelo/api": `${root}apps/api/src/index.ts`,
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "workers/test/**/*.test.ts",
    ],
  },
});
