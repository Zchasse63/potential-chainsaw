/**
 * Glofox connection config (docs/glofox/README.md §1).
 *
 * Phase 1 is SINGLE-TENANT: credentials come from process env. When tenant #2
 * exists, per-tenant creds move to Supabase Vault and a per-tenant loader
 * replaces `glofoxConfigFromEnv` — a deliberate, documented phase-1
 * simplification (README header: "Credentials live in `.env` locally … and
 * move to Supabase Vault").
 */
export interface GlofoxConfig {
  /** e.g. "https://gf-api.aws.glofox.com/prod/" — endpoint paths are appended. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiToken: string;
  readonly branchId: string;
  /** REQUIRED for the Analytics report — omitting it silently empties it (trap 2). */
  readonly namespace: string;
}

/** Env var NAMES — values are never logged or embedded in errors. */
const ENV_VAR_NAMES: Record<keyof GlofoxConfig, string> = {
  baseUrl: "GLOFOX_BASE_URL",
  apiKey: "GLOFOX_API_KEY",
  apiToken: "GLOFOX_API_TOKEN",
  branchId: "GLOFOX_BRANCH_ID",
  namespace: "GLOFOX_NAMESPACE",
};

/**
 * Reads the five GLOFOX_* env vars BY NAME. Throws one clear error naming every
 * missing var; values never appear in the error (no secrets in logs).
 */
export function glofoxConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GlofoxConfig {
  const read = (name: string): string => env[name]?.trim() ?? "";
  const keys = Object.keys(ENV_VAR_NAMES) as (keyof GlofoxConfig)[];
  const missing = keys.filter((key) => read(ENV_VAR_NAMES[key]) === "");
  if (missing.length > 0) {
    throw new Error(
      `Glofox config incomplete — missing env vars: ${missing
        .map((key) => ENV_VAR_NAMES[key])
        .join(", ")}. Set them in .env locally or the deploy env (docs/glofox/README.md §1).`,
    );
  }
  return {
    baseUrl: read(ENV_VAR_NAMES.baseUrl),
    apiKey: read(ENV_VAR_NAMES.apiKey),
    apiToken: read(ENV_VAR_NAMES.apiToken),
    branchId: read(ENV_VAR_NAMES.branchId),
    namespace: read(ENV_VAR_NAMES.namespace),
  };
}
