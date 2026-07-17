import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  fetchInvitations,
  fetchTenant,
  fetchTenantUser,
  fetchTenantUsers,
  insertAuditEvent,
  insertInvitation,
  memberStatusSchema,
  revokeInvitation,
  tenantRoleSchema,
  updateTenant,
  updateTenantUser,
  type MemberPatch,
  type TenantPatch,
} from "../data.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

// Route-local request schemas (plan-final §3: Zod at every boundary). Zod
// strips unknown keys by default — a client-supplied tenant_id in a body is
// dropped unread; the tenant ALWAYS comes from membership (threat model §1).
const updateTenantBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .refine((b) => b.name !== undefined || b.settings !== undefined, {
    message: "at least one of name or settings is required",
  });

const updateMemberBodySchema = z
  .object({
    role: tenantRoleSchema.optional(),
    status: memberStatusSchema.optional(),
  })
  .refine((b) => b.role !== undefined || b.status !== undefined, {
    message: "at least one of role or status is required",
  });

const createInvitationBodySchema = z.object({
  email: z.string().email(),
  role: tenantRoleSchema,
});

const idParamSchema = z.object({ id: z.string().uuid() });

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function registerTenantRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // Any active member may read their tenant's settings.
  app.get("/tenant", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const tenant = await fetchTenant(userClient, tenantId);
    if (tenant === null) {
      throw new ApiError(404, "tenant_not_found", "tenant not found");
    }
    return c.json(c.var.ok({ tenant }), 200);
  });

  // Settings update — owner/manager only. `settings` REPLACES the whole
  // settings object (no deep-merge in phase 0).
  app.patch(
    "/tenant",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId, role } = tenantOf(c);
      const body = await parseBody(c, updateTenantBodySchema);

      const patch: TenantPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.settings !== undefined) patch.settings = body.settings;

      const updated = await updateTenant(userClient, tenantId, patch);
      if (updated === null) {
        throw new ApiError(404, "tenant_not_found", "tenant not found");
      }
      await insertAuditEvent(userClient, {
        tenantId,
        actorUserId: userId,
        actorRole: role,
        action: "tenant.settings_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { fields: Object.keys(patch) },
      });
      return c.json(c.var.ok({ tenant: updated }), 200);
    },
  );

  app.get(
    "/tenant/users",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const members = await fetchTenantUsers(userClient, tenantId);
      return c.json(c.var.ok({ members }), 200);
    },
  );

  // Update a member's role/status. `:id` is the tenant_users ROW id, scoped
  // to the resolved tenant (RLS + explicit filter — cross-tenant ids 404).
  // OWNER-only, and never one's OWN membership row — mirrors the hardened RLS
  // policy (migration 0004: owner-only + user_id <> auth.uid(), the
  // manager-self-escalation fix). The API rejects loudly what RLS would
  // silently filter to 0 rows, so callers get a clear 403 instead of a 404.
  app.patch(
    "/tenant/users/:id",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner"),
    requireIdempotencyKey,
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId, role } = tenantOf(c);
      const { id } = parseParams(c, idParamSchema);
      const body = await parseBody(c, updateMemberBodySchema);

      const patch: MemberPatch = {};
      if (body.role !== undefined) patch.role = body.role;
      if (body.status !== undefined) patch.status = body.status;

      const existing = await fetchTenantUser(userClient, tenantId, id);
      if (existing === null) {
        throw new ApiError(404, "member_not_found", "member not found");
      }
      if (existing.user_id === userId) {
        throw new ApiError(
          403,
          "cannot_modify_own_membership",
          "you cannot modify your own membership row — another owner must",
        );
      }

      const updated = await updateTenantUser(userClient, tenantId, id, patch);
      if (updated === null) {
        throw new ApiError(404, "member_not_found", "member not found");
      }
      await insertAuditEvent(userClient, {
        tenantId,
        actorUserId: userId,
        actorRole: role,
        action: "tenant.user_updated",
        targetType: "tenant_user",
        targetId: id,
        metadata: { changes: patch },
      });
      return c.json(c.var.ok({ member: updated }), 200);
    },
  );

  app.get(
    "/tenant/invitations",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const invitations = await fetchInvitations(userClient, tenantId);
      return c.json(c.var.ok({ invitations }), 200);
    },
  );

  // Create an invitation. ONLY the sha256 hash of the token is stored
  // (migration 0002); the RAW token is returned ONCE here — the caller emails
  // it (no email send in phase 0) and it can never be retrieved again.
  app.post(
    "/tenant/invitations",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId, role } = tenantOf(c);
      const body = await parseBody(c, createInvitationBodySchema);

      const token = `${randomUUID()}.${randomBytes(32).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      const invitation = await insertInvitation(userClient, {
        tenant_id: tenantId,
        email: body.email,
        role: body.role,
        token_hash: tokenHash,
        expires_at: expiresAt,
        invited_by: userId,
      });
      await insertAuditEvent(userClient, {
        tenantId,
        actorUserId: userId,
        actorRole: role,
        action: "tenant.invitation_created",
        targetType: "tenant_invitation",
        targetId: invitation.id,
        metadata: { email: body.email, role: body.role },
      });
      return c.json(c.var.ok({ invitation, token }), 200);
    },
  );

  app.post(
    "/tenant/invitations/:id/revoke",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId, role } = tenantOf(c);
      const { id } = parseParams(c, idParamSchema);

      const revoked = await revokeInvitation(userClient, tenantId, id);
      if (revoked === null) {
        throw new ApiError(404, "invitation_not_found", "pending invitation not found");
      }
      await insertAuditEvent(userClient, {
        tenantId,
        actorUserId: userId,
        actorRole: role,
        action: "tenant.invitation_revoked",
        targetType: "tenant_invitation",
        targetId: id,
      });
      return c.json(c.var.ok({ invitation: revoked }), 200);
    },
  );
}
