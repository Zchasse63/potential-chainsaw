import { Pool } from "pg";
import { requireEnv } from "./env.js";

/**
 * Direct Postgres pool — WORKERS ONLY, under service credentials.
 *
 * The queue/observability functions (app.enqueue_job, app.claim_jobs,
 * app.complete_job, app.fail_job, app.reap_expired_leases, …) live in the `app`
 * schema, which is NOT PostgREST-exposed — supabase-js `.rpc()` cannot reach
 * them. Workers therefore talk to Postgres directly over the pg wire protocol
 * through this pool.
 *
 * SUPABASE_DB_URL is the direct/pooler Postgres connection string — NEVER the
 * anon key. The connecting role bypasses RLS, so this pool is at least as
 * powerful as createServiceRoleClient(): it must never appear in apps/web or
 * any client-reachable code (same ESLint/CI gates as the service-role key).
 */
export function createDbPool(): Pool {
  return new Pool({ connectionString: requireEnv("SUPABASE_DB_URL") });
}
