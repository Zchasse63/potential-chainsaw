import type { Hono } from "hono";
import { z } from "zod";
import {
  activateWaiverVersion,
  createWaiverVersion,
  listWaiverVersions,
  nextWaiverVersion,
  personWaiverStatus,
  recordWaiverSignature,
} from "../data-waivers.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const personParams = z.object({ personId: uuid });

const versionCreate = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(50_000),
});

// The desk (in-person) signature: acknowledged MUST be true and the typed name
// must be non-empty — the same checks the DB enforces, surfaced as 422 here.
const signBody = z.object({
  person_id: uuid,
  waiver_version_id: uuid,
  typed_name: z.string().trim().min(1).max(200),
  acknowledged: z.literal(true),
});

const native = { source: "native" as const, definitionVersion: "waivers:v1" };

export function registerWaiverRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.get("/waivers/versions", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ versions: await listWaiverVersions(userClient, tenantId) }, native), 200);
  });

  app.post(
    "/waivers/versions",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const body = await parseBody(c, versionCreate);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const version = await nextWaiverVersion(userClient, tenantId);
      const created = await createWaiverVersion(userClient, {
        tenant_id: tenantId,
        version,
        title: body.title ?? null,
        body: body.body,
        created_by: userId,
      });
      // Created INACTIVE; publishing is the explicit activate below.
      return c.json(c.var.ok({ version: created }, native), 201);
    },
  );

  app.post(
    "/waivers/versions/:id/activate",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const activated = await activateWaiverVersion(userClient, {
        p_tenant: tenantId,
        p_version_id: id,
        p_actor: userId,
      });
      if (!activated) throw new ApiError(404, "waiver_version_not_found", "waiver version not found");
      return c.json(c.var.ok({ activated: true, version_id: id }, native), 200);
    },
  );

  app.get("/waivers/status/:personId", requireAuth(deps), resolveTenant, async (c) => {
    const { personId } = parseParams(c, personParams);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const status = await personWaiverStatus(userClient, { p_tenant: tenantId, p_person: personId });
    if (status === null) throw new ApiError(404, "person_not_found", "person not found");
    return c.json(c.var.ok({ status }, native), 200);
  });

  // Desk capture — front-desk staff record an in-person signature. The row is
  // append-only legal evidence; a re-sign is a NEW row (the RPC never mutates).
  app.post(
    "/waivers/sign",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    requireIdempotencyKey,
    async (c) => {
      const body = await parseBody(c, signBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const userAgent = c.req.header("user-agent") ?? null;
      const signatureId = await recordWaiverSignature(userClient, {
        p_tenant: tenantId,
        p_person: body.person_id,
        p_waiver_version: body.waiver_version_id,
        p_typed_name: body.typed_name,
        p_acknowledged: body.acknowledged,
        p_source: "desk",
        p_ip_hash: null,
        p_user_agent: userAgent,
        p_actor: userId,
      });
      return c.json(c.var.ok({ signature_id: signatureId }, native), 201);
    },
  );
}
