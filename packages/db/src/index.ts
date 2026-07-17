import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";
import { requireEnv } from "./env.js";

export type { Database } from "./database.types.js";
export { createDbPool } from "./pool.js";
export { requireEnv } from "./env.js";

/** Typed Supabase client for Kelo's (currently stubbed) schema. */
export type KeloSupabaseClient = SupabaseClient<Database>;

/**
 * Anon-key client — RLS applies (invariant #7). The right choice for anything
 * user-scoped. Reads SUPABASE_URL / SUPABASE_ANON_KEY from the environment.
 */
export function createAnonClient(): KeloSupabaseClient {
  return createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"));
}

/**
 * Service-role client — BYPASSES RLS. Workers/webhooks only, NEVER apps/web
 * (ESLint guardrail + CI secrets grep enforce). Every service-role query must
 * still filter tenant explicitly and write an audit event.
 */
export function createServiceRoleClient(): KeloSupabaseClient {
  return createClient<Database>(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
