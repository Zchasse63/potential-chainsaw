import { defineConfig, devices } from "@playwright/test";

/**
 * WS-2 — Playwright E2E harness for the member surface.
 *
 * This config is NOT part of the required CI (`pnpm -w test` is Vitest only and
 * its include globs never match `e2e/`). It runs via `npx playwright test`, in
 * the dedicated `.github/workflows/e2e.yml` job or locally against a full local
 * Supabase stack. See e2e/README.md for the exact stand-up (the member API
 * route calls PostgREST via the Supabase JS client, so a plain Postgres is not
 * enough — a local Supabase is required).
 *
 * The two dev servers are started by Playwright with the env the member SSR +
 * API need. Ports match the codebase: API PORT 8787 (apps/api/src/server.ts,
 * base path /api/v1, unauthenticated /health/ping), member app on 4174.
 */

const API_ORIGIN = process.env.KELO_API_ORIGIN ?? "http://127.0.0.1:8787";
// `localhost` (not 127.0.0.1) so the check works whether the Vite dev server
// bound IPv4 or IPv6 (it defaults to ::1).
const MEMBER_ORIGIN = process.env.KELO_MEMBER_ORIGIN ?? "http://localhost:4174";
// The fixed tenant id seeded by supabase/tests/seed.e2e.sql.
const E2E_TENANT_ID = process.env.KELO_TENANT_ID ?? "e2e00000-0000-4000-8000-000000000001";

// Set KELO_E2E_NO_WEBSERVER=1 to run against a stack you started yourself
// (e.g. the API + member app already up against a live or branch project).
const MANAGE_SERVERS = process.env.KELO_E2E_NO_WEBSERVER !== "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: MEMBER_ORIGIN,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: !MANAGE_SERVERS ? undefined : [
    {
      // Needs a prior `pnpm --filter @kelo/api build` (the e2e workflow does it).
      command: "pnpm --filter @kelo/api dev",
      url: `${API_ORIGIN}/api/v1/health/ping`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: "8787",
        // Point the API at the local Supabase stack (values from `supabase start`).
        SUPABASE_URL: process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      },
    },
    {
      command: "pnpm --filter @kelo/member dev --port 4174",
      url: MEMBER_ORIGIN,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        KELO_API_ORIGIN: API_ORIGIN,
        KELO_TENANT_ID: E2E_TENANT_ID,
        KELO_TENANT_TIMEZONE: "UTC",
      },
    },
  ],
});
