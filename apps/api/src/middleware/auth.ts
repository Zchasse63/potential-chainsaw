import { createAnonClient, createUserClient } from "@kelo/db";
import type { MiddlewareHandler } from "hono";
import { AuthError } from "../errors.js";
import type { AppDeps, AppEnv, ResolvedDeps } from "../types.js";

/**
 * Network verification via Supabase Auth — correct + simple for phase 0 (the
 * token is verified by the issuer, so revoked/expired tokens fail closed).
 * TODO(perf): switch hot paths to local JWKS verification — auth.getUser is a
 * network round-trip per request.
 */
async function defaultVerifyAccessToken(accessToken: string): Promise<{ userId: string } | null> {
  const { data, error } = await createAnonClient().auth.getUser(accessToken);
  if (error !== null || data.user === null) {
    return null;
  }
  return { userId: data.user.id };
}

export function resolveDeps(deps: AppDeps = {}): ResolvedDeps {
  return {
    verifyAccessToken: deps.verifyAccessToken ?? defaultVerifyAccessToken,
    createUserClient: deps.createUserClient ?? createUserClient,
  };
}

const BEARER_PREFIX = "Bearer ";

/**
 * Auth: verify the Bearer token (issuer-verified), then attach
 * { userId, accessToken, userClient }. The userClient is RLS-scoped to the
 * authenticated user — every downstream query runs AS them (invariant #7).
 * No/invalid token → AuthError → 401 structured error.
 */
export function requireAuth(deps: ResolvedDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token =
      header !== undefined && header.startsWith(BEARER_PREFIX)
        ? header.slice(BEARER_PREFIX.length).trim()
        : "";
    if (token === "") {
      throw new AuthError("a Bearer token is required");
    }
    const user = await deps.verifyAccessToken(token);
    if (user === null) {
      throw new AuthError("the token is invalid or expired");
    }
    c.set("userId", user.userId);
    c.set("accessToken", token);
    c.set("userClient", deps.createUserClient(token));
    await next();
  };
}
