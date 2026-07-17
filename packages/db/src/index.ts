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
 * User-scoped client — every query runs AS the authenticated user, RLS
 * enforced (invariant #7). The API's requireAuth middleware builds one per
 * request from the verified Bearer token: the anon key identifies the project,
 * the `Authorization: Bearer <accessToken>` global header makes PostgREST and
 * auth.admin treat every call as that user (their JWT is forwarded, so RLS
 * policies see auth.uid() = the verified user). NEVER the service role.
 */
export function createUserClient(accessToken: string): KeloSupabaseClient {
  return createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
