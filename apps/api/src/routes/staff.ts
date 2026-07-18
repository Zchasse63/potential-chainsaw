import type { Context, Hono } from "hono";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import { z } from "zod";
import { hashAuditIp, hashStepUpPin, issueStepUpGrant, verifyStepUpPin } from "../auth/stepup.js";
import {
  fetchStaffRoster,
  fetchStepUpCredential,
  fetchStepUpStatus,
  fetchTenantUserByUserId,
  recordStepUpAttempt,
  setStepUpPin,
  type TenantRole,
} from "../data.js";
import { ApiError, errorBody } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

const userParamSchema = z.object({ userId: z.string().uuid() });
const pinBodySchema = z.object({ pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits") });
const verifyBodySchema = pinBodySchema.extend({
  context: z.string().regex(/^[a-z][a-z0-9_:-]{0,99}$/, "invalid action context"),
});

const ROLE_RANK: Record<TenantRole, number> = {
  owner: 4,
  manager: 3,
  front_desk: 2,
  trainer: 1,
};

function mayManagePin(
  actorId: string,
  actorRole: TenantRole,
  targetId: string,
  targetRole: TenantRole,
) {
  if (actorId === targetId) return true;
  return (
    (actorRole === "owner" || actorRole === "manager") &&
    ROLE_RANK[actorRole] > ROLE_RANK[targetRole]
  );
}

function requireStepUpSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.STEP_UP_SECRET;
  if (secret === undefined || Buffer.byteLength(secret) < 32) {
    throw new Error("STEP_UP_SECRET is missing or shorter than 32 bytes");
  }
  return secret;
}

function lockedResponse(c: Context<AppEnv>, lockedUntil: string) {
  return c.json(
    errorBody(
      "step_up_locked",
      "step-up verification is locked after repeated failures",
      c.var.correlationId,
      { locked_until: lockedUntil },
    ),
    423,
  );
}

/**
 * Shared-device identity proof. Phase-5 refund/void/discount routes will
 * require the returned HMAC grant for above-threshold mutations; this unit
 * intentionally ships the mechanism, not those money routes.
 */
export function registerStaffRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  env: NodeJS.ProcessEnv = process.env,
  createCredentialClient: () => KeloSupabaseClient = createServiceRoleClient,
): void {
  app.get(
    "/staff",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId, role } = tenantOf(c);
      const staff = await fetchStaffRoster(userClient, tenantId);
      return c.json(
        c.var.ok({
          staff: staff.map((member) => ({
            ...member,
            is_self: member.user_id === userId,
            can_manage_pin: mayManagePin(userId, role, member.user_id, member.role),
          })),
        }),
        200,
      );
    },
  );

  app.post(
    "/staff/:userId/pin",
    requireAuth(deps),
    resolveTenant,
    requireIdempotencyKey,
    async (c) => {
      const { userId: actorId, userClient } = authOf(c);
      const { tenantId, role: actorRole } = tenantOf(c);
      const { userId: targetId } = parseParams(c, userParamSchema);
      const { pin } = await parseBody(c, pinBodySchema);
      const target = await fetchTenantUserByUserId(userClient, tenantId, targetId);
      if (target === null) throw new ApiError(404, "staff_not_found", "staff member not found");
      if (target.status !== "active") {
        throw new ApiError(409, "staff_inactive", "a PIN cannot be set for inactive staff");
      }
      if (!mayManagePin(actorId, actorRole, target.user_id, target.role)) {
        throw new ApiError(
          403,
          "cannot_manage_staff_pin",
          "you may set only your own PIN or a strictly lower-role staff PIN",
        );
      }

      // The raw PIN exists only in request memory and is never sent to the DB,
      // response, audit metadata, or logger.
      const pinHash = hashStepUpPin(pin);
      await setStepUpPin(userClient, {
        tenantId,
        userId: target.user_id,
        pinHash,
        actorId,
      });
      return c.json(c.var.ok({ user_id: target.user_id, pin_set: true }), 200);
    },
  );

  app.post(
    "/staff/step-up/verify",
    requireAuth(deps),
    resolveTenant,
    requireIdempotencyKey,
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const { pin, context } = await parseBody(c, verifyBodySchema);
      const status = await fetchStepUpStatus(userClient, tenantId, userId);
      if (status === null) {
        throw new ApiError(404, "staff_not_found", "active staff membership not found");
      }
      if (status.locked_until !== null) return lockedResponse(c, status.locked_until);

      const secret = requireStepUpSecret(env);
      // This is the sole server-side read of step_up_pin_hash. A missing PIN
      // follows the same failed-attempt path and is never disclosed separately.
      const stepUpClient = createCredentialClient();
      const credential = await fetchStepUpCredential(stepUpClient, tenantId, userId);
      const success = verifyStepUpPin(pin, credential);
      const ip = c.req.header("x-nf-client-connection-ip") ?? c.req.header("x-forwarded-for");
      // Comparison outcomes use the same server-only client. A browser cannot
      // forge success to reset its shared failure counter.
      const lockState = await recordStepUpAttempt(stepUpClient, {
        tenantId,
        userId,
        success,
        context,
        ipHash: hashAuditIp(ip, secret),
      });

      if (lockState.locked_until !== null) return lockedResponse(c, lockState.locked_until);
      if (!success || !lockState.attempt_recorded) {
        throw new ApiError(401, "step_up_failed", "the step-up PIN was not accepted", {
          remaining_attempts: lockState.remaining_attempts,
        });
      }

      const grant = issueStepUpGrant({ sub: userId, tenant: tenantId, context }, secret);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      return c.json(
        c.var.ok({
          grant_token: grant,
          grant: { sub: userId, tenant: tenantId, context, expires_at: expiresAt },
        }),
        200,
      );
    },
  );
}
