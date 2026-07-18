import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  fetchDataExport,
  fetchEffectiveRetentionPolicies,
  pseudonymizePerson,
  requestPersonExport,
} from "../data.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

const idParams = z.object({ id: z.string().uuid() });
const deleteBody = z.object({ reason: z.string().trim().min(1).max(2000).optional() });

/** Phase-3 data-rights API. Tenant and actor always come from middleware. */
export function registerPeopleRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // Although represented as GET for the specified API surface, this creates a
  // durable async job and therefore uses full mutation hygiene + role gating.
  app.get(
    "/people/:id/export",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { id: personId } = parseParams(c, idParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
      if (idempotencyKey === undefined) throw new Error("idempotency middleware did not run");
      const exportId = await requestPersonExport(userClient, {
        tenantId,
        personId,
        actorId: userId,
        idempotencyKey,
      });
      return c.json(
        c.var.ok(
          { export_id: exportId, status: "queued" },
          { source: "native", definitionVersion: "person-dsar:v1" },
        ),
        202,
      );
    },
  );

  app.get(
    "/data-exports/:id",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const dataExport = await fetchDataExport(userClient, tenantId, id);
      if (dataExport === null) {
        throw new ApiError(404, "data_export_not_found", "data export not found");
      }
      return c.json(
        c.var.ok(
          { export: dataExport },
          { source: "native", definitionVersion: "person-dsar:v1" },
        ),
        200,
      );
    },
  );

  app.post(
    "/people/:id/delete",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { id: personId } = parseParams(c, idParams);
      const body = await parseBody(c, deleteBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const deletion = await pseudonymizePerson(userClient, {
        tenantId,
        personId,
        actorId: userId,
        reason: body.reason ?? null,
      });
      return c.json(
        c.var.ok(
          { deletion },
          { source: "native", definitionVersion: "person-erasure:v1" },
        ),
        200,
      );
    },
  );

  app.get(
    "/retention/policies",
    requireAuth(deps),
    resolveTenant,
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const policies = await fetchEffectiveRetentionPolicies(userClient, tenantId);
      return c.json(
        c.var.ok(
          { policies },
          { source: "native", definitionVersion: "retention-matrix:v1" },
        ),
        200,
      );
    },
  );
}
