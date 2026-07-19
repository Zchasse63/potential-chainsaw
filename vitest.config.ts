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
      "@kelo/comms": `${root}packages/comms/src/index.ts`,
      "@kelo/stripe": `${root}packages/stripe/src/index.ts`,
      "@kelo/db": `${root}packages/db/src/index.ts`,
      "@kelo/glofox": `${root}packages/glofox/src/index.ts`,
      "@kelo/workers": `${root}workers/src/index.ts`,
      "@kelo/api": `${root}apps/api/src/index.ts`,
      // @kelo/ui/react resolves to its TS source so component tests run
      // without requiring a prior @kelo/ui build (same rule as the others).
      "@kelo/ui/react": `${root}packages/ui/react/index.ts`,
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      // Component tests (React TSX; each file opts into the jsdom
      // environment via its @vitest-environment docblock).
      "packages/*/test/**/*.test.tsx",
      "apps/*/test/**/*.test.tsx",
      "workers/test/**/*.test.ts",
    ],
  },
});
