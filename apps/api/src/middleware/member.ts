import { createHash } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import {
  findMemberSessionByTokenHash,
  findPersonClaimStatus,
  slideMemberSession,
} from "../data-member.js";
import { ApiError } from "../errors.js";
import type { AppEnv } from "../types.js";

/**
 * resolveMember — THE SOLE SOURCE OF member person_id (plan-member-app §3.4),
 * the structural twin of resolveTenant. Every session-scoped member route
 * (unit 8.2c+: account, bookings, me, refresh/logout/step-up) mounts this and
 * reads identity from context via memberOf(); request-supplied person or
 * tenant ids are NEVER consulted.
 *
 * The chain: `kelo_member` cookie OR `Authorization: Bearer kmb_…` → sha256 →
 * service-role lookup on member_sessions by token_hash (the table has no
 * client-readable policy at all) → reject revoked/expired → slide the rolling
 * expiry → require the person's ACTIVE person_claims row.
 *
 * Neutral-failure contract (anti-enumeration): an unknown, revoked, or expired
 * token is one indistinguishable 401; a session whose claim is absent or not
 * ACTIVE is a 403 with the SAME code + message (a needs_resolution session may
 * only reach the claim-status endpoint — unit 8.2c — so it learns nothing here
 * about balances or identity beyond what verify already returned).
 */

export const MEMBER_COOKIE = "kelo_member";
export const MEMBER_TOKEN_PREFIX = "kmb_";

/** Rolling session window (90 days) — also the cookie Max-Age. */
export const MEMBER_SESSION_ROLLING_MS = 90 * 24 * 60 * 60 * 1000;
export const MEMBER_SESSION_ROLLING_SECONDS = Math.floor(MEMBER_SESSION_ROLLING_MS / 1000);

const BEARER_PREFIX = "Bearer ";

/** ONE message for every member-auth failure — never a hint at which check failed. */
export const MEMBER_SESSION_NEUTRAL_MESSAGE = "a valid member session is required";

export interface MemberAuthDeps {
  /** Service-role client factory; tests inject a no-network fake. */
  createMemberClient?: () => KeloSupabaseClient;
}

/** The presented credential: cookie first (web), then the Bearer header
 * (mobile). Exported so /member/auth/refresh can read the SAME credential
 * without resolveMember (which 401s revoked/rotated tokens — refresh must see
 * them to run reuse-detection). */
export function presentedMemberToken(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  const cookieToken = getCookie(c)[MEMBER_COOKIE];
  if (cookieToken !== undefined && cookieToken.startsWith(MEMBER_TOKEN_PREFIX)) {
    return cookieToken;
  }
  const header = c.req.header("authorization");
  if (header !== undefined && header.startsWith(BEARER_PREFIX)) {
    const bearer = header.slice(BEARER_PREFIX.length).trim();
    if (bearer.startsWith(MEMBER_TOKEN_PREFIX)) return bearer;
  }
  return null;
}

export function resolveMember(deps: MemberAuthDeps = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = presentedMemberToken(c);
    if (token === null) {
      throw new ApiError(401, "unauthorized", MEMBER_SESSION_NEUTRAL_MESSAGE);
    }

    const client = deps.createMemberClient?.() ?? createServiceRoleClient();
    // Only the sha256 hash ever touches the database — the raw token is never
    // persisted or logged (the 0031 rule, §3.2).
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = await findMemberSessionByTokenHash(client, tokenHash);

    const now = new Date();
    if (
      session === null ||
      session.revoked_at !== null ||
      Date.parse(session.expires_at) <= now.getTime() ||
      Date.parse(session.absolute_expires_at) <= now.getTime()
    ) {
      throw new ApiError(401, "unauthorized", MEMBER_SESSION_NEUTRAL_MESSAGE);
    }

    const scope = { tenantId: session.tenant_id, personId: session.person_id };
    const claim = await findPersonClaimStatus(scope, client);
    if (claim === null || claim.status !== "active") {
      // Absent/needs_resolution/frozen/revoked claim: the same neutral shape
      // as an unknown session, at 403. Balances and identity stay sealed; the
      // claim-status endpoint (8.2c) is the only route these sessions reach.
      throw new ApiError(403, "unauthorized", MEMBER_SESSION_NEUTRAL_MESSAGE);
    }

    // Slide: last_seen_at + rolling 90-day expiry (absolute cap untouched).
    await slideMemberSession(
      scope,
      client,
      session.id,
      now.toISOString(),
      new Date(now.getTime() + MEMBER_SESSION_ROLLING_MS).toISOString(),
    );
    // Re-set the cookie when it was the credential source so the browser-side
    // Max-Age slides with the DB expiry (host-only, HttpOnly, SameSite=Lax).
    if (getCookie(c)[MEMBER_COOKIE] === token) {
      setCookie(c, MEMBER_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: MEMBER_SESSION_ROLLING_SECONDS,
      });
    }

    c.set("memberTenantId", scope.tenantId);
    c.set("memberPersonId", scope.personId);
    c.set("memberSessionId", session.id);
    c.set("memberStepUpAt", session.step_up_at);
    await next();
  };
}
