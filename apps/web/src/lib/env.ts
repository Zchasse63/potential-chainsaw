/**
 * Client env, read BY NAME only — no values ever live in this repo
 * (CLAUDE.md secrets rule). Missing values degrade to honest states
 * (unconfigured auth / disabled telemetry), never to crashes.
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
export const SUPABASE_URL: string | undefined = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const SENTRY_DSN: string | undefined = import.meta.env.VITE_SENTRY_DSN;
