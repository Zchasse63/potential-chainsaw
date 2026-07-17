/**
 * Reads a required env var BY NAME — values live in .env locally and in
 * Netlify/Supabase env in deploys (per-tenant Glofox credentials move to
 * Supabase Vault). Nothing is ever hardcoded here.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`@kelo/db: missing required environment variable ${name}`);
  }
  return value;
}
