import type { Context } from "hono";
import type { Envelope, EnvelopeSource } from "@kelo/contracts";
import type { KeloSupabaseClient } from "@kelo/db";
import type { TenantRole } from "./data.js";

/** Options for the freshness-envelope helper (contracts/envelope.ts). */
export interface OkOptions {
  source?: EnvelopeSource;
  stale?: boolean;
  definitionVersion?: string | null;
}

/**
 * Builds `{ data, meta }` — EVERY success response goes through this helper
 * (CLAUDE.md invariant #3; plan-final §3).
 */
export type OkHelper = <T>(data: T, opts?: OkOptions) => Envelope<T>;

/**
 * Hono context variables. The auth/tenant vars are optional in the type
 * because they are set by per-route middleware; handlers read them through the
 * authOf()/tenantOf() accessors below, which throw if the middleware chain was
 * misconfigured (a server defect → 500, never silent undefined).
 */
export type AppEnv = {
  Variables: {
    correlationId: string;
    ok: OkHelper;
    // set by requireAuth
    userId?: string;
    accessToken?: string;
    userClient?: KeloSupabaseClient;
    // set by resolveTenant
    tenantId?: string;
    role?: TenantRole;
  };
};

export interface AuthVars {
  userId: string;
  accessToken: string;
  userClient: KeloSupabaseClient;
}

export interface TenantVars {
  tenantId: string;
  role: TenantRole;
}

/** Read the auth context set by requireAuth (throws if it did not run). */
export function authOf(c: Context<AppEnv>): AuthVars {
  const { userId, accessToken, userClient } = c.var;
  if (userId === undefined || accessToken === undefined || userClient === undefined) {
    throw new Error("requireAuth middleware did not run for this route");
  }
  return { userId, accessToken, userClient };
}

/** Read the tenant context set by resolveTenant (throws if it did not run). */
export function tenantOf(c: Context<AppEnv>): TenantVars {
  const { tenantId, role } = c.var;
  if (tenantId === undefined || role === undefined) {
    throw new Error("resolveTenant middleware did not run for this route");
  }
  return { tenantId, role };
}

/**
 * Injectable seams — unit tests inject fakes so no live Supabase is needed.
 * Defaults live in middleware/auth.ts.
 */
export interface AppDeps {
  /** Verify a Bearer token; resolve the authenticated user id, or null. */
  verifyAccessToken?: (accessToken: string) => Promise<{ userId: string } | null>;
  /** Build the user-scoped (RLS-enforced) Supabase client for a verified token. */
  createUserClient?: (accessToken: string) => KeloSupabaseClient;
}

export interface ResolvedDeps {
  verifyAccessToken: (accessToken: string) => Promise<{ userId: string } | null>;
  createUserClient: (accessToken: string) => KeloSupabaseClient;
}
