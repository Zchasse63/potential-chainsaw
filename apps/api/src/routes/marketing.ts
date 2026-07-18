import type { Hono } from "hono";
import { z } from "zod";
import {
  approveCampaign,
  cancelCampaign,
  createCampaign,
  fetchCampaignDetail,
  fetchCampaigns,
  fetchTemplates,
  planCampaign,
} from "../data.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

const idParams = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  segment_key: z.string().trim().min(1).max(100),
  template_key: z.string().trim().min(1).max(160),
  channel: z.enum(["email", "sms"]),
});

async function requireCampaign(
  client: Parameters<typeof fetchCampaignDetail>[0],
  tenantId: string,
  id: string,
) {
  const detail = await fetchCampaignDetail(client, tenantId, id);
  if (detail === null) throw new ApiError(404, "campaign_not_found", "campaign not found");
  return detail;
}

export function registerMarketingRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.get("/marketing/templates", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(
      c.var.ok({ templates: await fetchTemplates(userClient, tenantId) }, { source: "native" }),
      200,
    );
  });

  app.get("/marketing/campaigns", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(
      c.var.ok(
        { campaigns: await fetchCampaigns(userClient, tenantId) },
        { source: "native", definitionVersion: "campaign:v1" },
      ),
      200,
    );
  });

  app.get("/marketing/campaigns/:id", requireAuth(deps), resolveTenant, async (c) => {
    const { id } = parseParams(c, idParams);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const detail = await requireCampaign(userClient, tenantId, id);
    return c.json(
      c.var.ok(detail, { source: "native", definitionVersion: "campaign:v1" }),
      200,
    );
  });

  app.post(
    "/marketing/campaigns",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const input = await parseBody(c, createSchema);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const campaign = await createCampaign(userClient, {
        tenantId,
        actorId: userId,
        name: input.name ?? `${input.segment_key.replaceAll("_", " ")} outreach`,
        segmentKey: input.segment_key,
        templateKey: input.template_key,
        channel: input.channel,
      });
      return c.json(c.var.ok({ campaign }, { source: "native" }), 201);
    },
  );

  app.post(
    "/marketing/campaigns/:id/plan",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      await requireCampaign(userClient, tenantId, id);
      const planned = await planCampaign(userClient, id);
      const detail = await requireCampaign(userClient, tenantId, id);
      return c.json(c.var.ok({ planned, detail }, { source: "native" }), 200);
    },
  );

  // THE ONLY API send trigger. The user-scoped RPC re-checks owner/manager,
  // binds p_actor to auth.uid(), records approved_by/at, and is idempotent.
  app.post(
    "/marketing/campaigns/:id/approve",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      await requireCampaign(userClient, tenantId, id);
      const enqueued = await approveCampaign(userClient, id, userId);
      const detail = await requireCampaign(userClient, tenantId, id);
      return c.json(c.var.ok({ enqueued, detail }, { source: "native" }), 200);
    },
  );

  app.post(
    "/marketing/campaigns/:id/cancel",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      await requireCampaign(userClient, tenantId, id);
      const campaign = await cancelCampaign(userClient, tenantId, id);
      if (campaign === null) {
        throw new ApiError(409, "campaign_not_cancellable", "only draft proposals can be cancelled");
      }
      return c.json(c.var.ok({ campaign }, { source: "native" }), 200);
    },
  );
}
