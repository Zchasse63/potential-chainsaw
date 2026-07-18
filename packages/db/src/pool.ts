import { readFileSync } from "node:fs";
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
  // Supabase's pooler presents a chain signed by the Supabase Root CA, which
  // Node does not trust by default. SUPABASE_DB_SSL_CA (a file path or the PEM
  // itself) enables full certificate verification — the preferred posture.
  // Without it, the URL's own sslmode governs (verify-full against system CAs
  // for direct connections that chain publicly).
  const caEnv = process.env["SUPABASE_DB_SSL_CA"];
  const ca =
    caEnv === undefined || caEnv === ""
      ? undefined
      : caEnv.includes("-----BEGIN")
        ? caEnv
        : readFileSync(caEnv, "utf8");
  let connectionString = requireEnv("SUPABASE_DB_URL");
  if (ca !== undefined) {
    // A URL-level sslmode (e.g. Supabase's default `sslmode=prefer`) makes the
    // pg connection-string parser emit its own ssl config that FIGHTS the
    // explicit option below (observed live: the CA was silently ignored).
    // With a CA provided, the explicit verify-full config is authoritative.
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("sslrootcert");
    connectionString = url.toString();
  }
  return new Pool({
    connectionString,
    ...(ca !== undefined ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
}
