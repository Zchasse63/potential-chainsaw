/**
 * @kelo/api — the ONE Hono API app (plan-final §1/§3): /api/v1, freshness
 * envelope on every success response, structured non-200 errors, tenant id
 * derived server-side from membership only (threat model §1).
 */
export { createApp } from "./app.js";
export { default as app } from "./app.js";
export type { AppDeps, AppEnv, OkHelper, OkOptions } from "./types.js";
export { ApiError, AuthError, TenantError } from "./errors.js";
