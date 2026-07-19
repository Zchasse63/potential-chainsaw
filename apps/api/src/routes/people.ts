import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  fetchDataExport,
  fetchEffectiveRetentionPolicies,
  pseudonymizePerson,
  requestPersonExport,
  searchPeople,
} from "../data.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams, parseQuery } from "../validate.js";

const idParams = z.object({ id: z.string().uuid() });
const deleteBody = z.object({ reason: z.string().trim().min(1).max(2000).optional() });

// Desk-search query. Request schemas live inline in the route file (the repo
// pattern — cf. bookings.ts holdBody / availabilityQuery); @kelo/contracts holds
// the envelope + Glofox shapes, not per-route request schemas. q is trimmed then
// min(2) so an empty/1-char query 422s instead of enumerating the directory;
// limit mirrors briefing.ts (coerce → int → ≤20, default 10; >20 is a 422).
const searchQuery = z.object({
  q: z.string().trim().min(2, "q must be at least 2 characters after trimming"),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

/** Phase-3 data-rights API. Tenant and actor always come from middleware. */
export function registerPeopleRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // -- desk person search (Quick Book, plan-ux §3C) --------------------------
  // Front-desk-and-up read: RLS (user client) scopes the result to the tenant.
  // A read, so no idempotency guard; role-gated because the typeahead exposes
  // member PII (fine over the authed API, never to a trainer surface).
  app.get(
    "/people/search",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    async (c) => {
      const { q, limit } = parseQuery(c, searchQuery);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const { people, truncated } = await searchPeople(userClient, tenantId, { q, limit });
      return c.json(
        c.var.ok(
          { people, truncated },
          { source: "native", definitionVersion: "people-search:v1" },
        ),
        200,
      );
    },
  );


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
