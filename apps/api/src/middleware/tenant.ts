import type { MiddlewareHandler } from "hono";
import { fetchMemberships, type TenantRole } from "../data.js";
import { ApiError, TenantError } from "../errors.js";
import { authOf, tenantOf, type AppEnv } from "../types.js";

export const TENANT_HEADER = "x-kelo-tenant";

/**
 * THE SOLE SOURCE OF TENANT ID (threat model §1 — "tenant always derived
 * server-side from membership, never trusted from the request body").
 *
 * Runs after requireAuth on tenant-scoped routes. The user-scoped client
 * (RLS) returns exactly the caller's ACTIVE memberships:
 *   0  → 403 TenantError (no active tenant membership)
 *   1  → that tenant_id + role
 *   >1 → the `x-kelo-tenant` header is required AND must be one of the fetched
 *        membership tenant_ids — anything else is 400.
 * Tenant ids from the request body or query string are NEVER consulted.
 */
export const resolveTenant: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { userId, userClient } = authOf(c);
  const memberships = await fetchMemberships(userClient, userId);

  const first = memberships[0];
  if (first === undefined) {
    throw new TenantError("no active tenant membership", 403, "no_active_membership");
  }

  let selected = first;
  if (memberships.length > 1) {
    const wanted = c.req.header(TENANT_HEADER);
    if (wanted === undefined || wanted === "") {
      throw new TenantError(
        `${TENANT_HEADER} header is required (multiple active memberships)`,
        400,
        "tenant_header_required",
      );
    }
    const match = memberships.find((m) => m.tenantId === wanted);
    if (match === undefined) {
      throw new TenantError(
        `${TENANT_HEADER} is not one of your active memberships`,
        400,
        "tenant_not_a_membership",
      );
    }
    selected = match;
  }

  c.set("tenantId", selected.tenantId);
  c.set("role", selected.role);
  await next();
};

/** Role guard: 403 unless the resolved membership role is in `roles`. */
export function requireRole(...roles: readonly TenantRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { role } = tenantOf(c);
    if (!roles.includes(role)) {
      throw new ApiError(
        403,
        "insufficient_role",
        `this action requires role: ${roles.join(" | ")}`,
      );
    }
    await next();
  };
}
