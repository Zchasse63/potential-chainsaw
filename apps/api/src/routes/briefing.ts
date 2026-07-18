import { z } from "zod";
import type { Hono } from "hono";
import {
  fetchBriefingArtifact,
  fetchBriefingArchive,
  fetchFocusQueue,
  fetchStudioTimezone,
  insertBriefingFeedback,
  insertFocusDismissal,
  previousBusinessDate,
  studioBusinessDate,
} from "../data-briefing.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseQuery } from "../validate.js";

const briefingQuerySchema = z.object({ fallback: z.literal("yesterday").optional() });
const archiveQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

const feedbackSchema = z.object({
  artifact_id: z.string().uuid(),
  item_ref: z.string().min(1).max(200),
  verdict: z.enum(["up", "down"]),
  reason: z.string().trim().min(1).max(1000).optional(),
});

const dismissalSchema = z
  .object({
    item_key: z.string().min(1).max(300),
    action: z.enum(["dismissed", "snoozed"]),
    reason: z.string().trim().min(1).max(1000).optional(),
    snooze_until: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "snoozed" && value.snooze_until === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snooze_until"],
        message: "snooze_until is required when action is snoozed",
      });
    }
    if (value.action === "dismissed" && value.snooze_until !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snooze_until"],
        message: "snooze_until is only valid when action is snoozed",
      });
    }
  });

export function registerBriefingRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.get("/briefing/archive", requireAuth(deps), resolveTenant, async (c) => {
    const { limit } = parseQuery(c, archiveQuerySchema);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const artifacts = await fetchBriefingArchive(userClient, tenantId, limit);
    return c.json(
      c.var.ok({ artifacts }, { source: "mixed", definitionVersion: "1" }),
      200,
    );
  });

  app.get("/briefing", requireAuth(deps), resolveTenant, async (c) => {
    const query = parseQuery(c, briefingQuerySchema);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const timezone = await fetchStudioTimezone(userClient, tenantId);
    const today = studioBusinessDate(timezone);
    let artifact = await fetchBriefingArtifact(userClient, tenantId, today);
    let stale = false;

    if (artifact === null && query.fallback === "yesterday") {
      artifact = await fetchBriefingArtifact(userClient, tenantId, previousBusinessDate(today));
      stale = artifact !== null;
    }
    if (artifact === null) {
      throw new ApiError(404, "briefing_not_generated", "today's briefing has not been generated", {
        generated_for: today,
      });
    }

    return c.json(
      c.var.ok(
        { artifact },
        {
          source: "mixed",
          stale,
          definitionVersion:
            artifact.prompt_version === null ? null : String(artifact.prompt_version),
        },
      ),
      200,
    );
  });

  app.post(
    "/briefing/feedback",
    requireAuth(deps),
    resolveTenant,
    requireIdempotencyKey,
    async (c) => {
      const input = await parseBody(c, feedbackSchema);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const feedback = await insertBriefingFeedback(userClient, {
        tenant_id: tenantId,
        artifact_id: input.artifact_id,
        item_ref: input.item_ref,
        verdict: input.verdict,
        reason: input.reason,
        actor_user_id: userId,
      });
      return c.json(c.var.ok({ feedback }, { source: "native" }), 201);
    },
  );

  app.get("/focus-queue", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const items = await fetchFocusQueue(userClient, tenantId);
    return c.json(c.var.ok({ items }, { source: "mixed", definitionVersion: "1" }), 200);
  });

  app.post(
    "/focus-queue/dismiss",
    requireAuth(deps),
    resolveTenant,
    requireIdempotencyKey,
    async (c) => {
      const input = await parseBody(c, dismissalSchema);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const dismissal = await insertFocusDismissal(userClient, {
        tenant_id: tenantId,
        item_key: input.item_key,
        action: input.action,
        reason: input.reason,
        snooze_until: input.snooze_until,
        actor_user_id: userId,
      });
      return c.json(c.var.ok({ dismissal }, { source: "native" }), 201);
    },
  );
}
