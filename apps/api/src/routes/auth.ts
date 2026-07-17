import type { Hono } from "hono";
import { fetchMemberships } from "../data.js";
import { requireAuth } from "../middleware/auth.js";
import { authOf, type AppEnv, type ResolvedDeps } from "../types.js";

export function registerAuthRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // Who am I + which tenants can I act for. NOT tenant-scoped (no
  // resolveTenant): this is how a multi-tenant client learns the valid
  // `x-kelo-tenant` values.
  app.get("/auth/me", requireAuth(deps), async (c) => {
    const { userId, userClient } = authOf(c);
    const memberships = await fetchMemberships(userClient, userId);
    return c.json(
      c.var.ok({
        user_id: userId,
        tenants: memberships.map((m) => ({ tenant_id: m.tenantId, role: m.role })),
      }),
      200,
    );
  });
}
