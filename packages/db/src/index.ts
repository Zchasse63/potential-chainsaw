import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

export type { Database } from "./database.types.js";

/** Typed Supabase client for Kelo's (currently stubbed) schema. */
export type KeloSupabaseClient = SupabaseClient<Database>;

/**
 * Reads a required env var BY NAME — values live in .env locally and in
 * Netlify/Supabase env in deploys (per-tenant Glofox credentials move to
 * Supabase Vault). Nothing is ever hardcoded here.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`@kelo/db: missing required environment variable ${name}`);
  }
  return value;
}

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
