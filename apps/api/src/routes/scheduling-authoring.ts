import type { Hono } from "hono";
import { z } from "zod";
import {
  createOfferingTemplate,
  createReadiness,
  createResource,
  createScheduleRule,
  createScheduledSession,
  deleteAuthoringEntity,
  expandScheduleRule,
  fetchOfferingTemplate,
  fetchOfferingTemplates,
  fetchReadiness,
  fetchResource,
  fetchResources,
  fetchScheduleRule,
  fetchScheduleRules,
  fetchScheduledSession,
  fetchScheduledSessions,
  fetchSchedulingTimezone,
  localWallTimeToInstant,
  publishSessions,
  readinessStateSchema,
  resourceKindSchema,
  updateDraftSession,
  updateOfferingTemplate,
  updateReadiness,
  updateResource,
  updateScheduleRule,
} from "../data-scheduling.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams, parseQuery } from "../validate.js";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const instant = z.string().datetime({ offset: true });
const windowQuery = z.object({ from: instant, to: instant }).superRefine((value, ctx) => {
  if (value.from >= value.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
});

const resourceCreate = z.object({
  name: z.string().trim().min(1).max(160),
  kind: resourceKindSchema.default("room"),
  capacity: z.number().int().positive().max(10_000).default(1),
  active: z.boolean().default(true),
});
const resourcePatch = resourceCreate.partial().refine((value) => Object.keys(value).length > 0, "at least one field is required");

const readinessCreate = z.object({
  resource_id: uuid,
  state: readinessStateSchema.default("ready"),
  effective_from: instant,
  effective_to: instant.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.effective_to !== undefined && value.effective_to !== null && value.effective_to <= value.effective_from) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effective_to"], message: "effective_to must be after effective_from" });
});
const readinessPatch = z.object({
  state: readinessStateSchema.optional(),
  effective_from: instant.optional(),
  effective_to: instant.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one field is required");

const templateCreate = z.object({
  name: z.string().trim().min(1).max(160),
  duration_minutes: z.number().int().positive().max(24 * 60),
  default_capacity: z.number().int().positive().max(10_000).nullable().optional(),
  kelo_type: z.string().trim().min(1).max(100).nullable().optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  active: z.boolean().default(true),
});
const templatePatch = templateCreate.partial().refine((value) => Object.keys(value).length > 0, "at least one field is required");

const ruleCreate = z.object({
  offering_template_id: uuid,
  resource_id: uuid,
  rrule: z.string().trim().min(1).max(1_000),
  local_start_time: localTime,
  start_date: localDate,
  end_date: localDate.nullable().optional(),
  active: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.end_date !== undefined && value.end_date !== null && value.end_date < value.start_date) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end_date"], message: "end_date must be on or after start_date" });
});
const rulePatch = z.object({
  offering_template_id: uuid.optional(),
  resource_id: uuid.optional(),
  rrule: z.string().trim().min(1).max(1_000).optional(),
  local_start_time: localTime.optional(),
  start_date: localDate.optional(),
  end_date: localDate.nullable().optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one field is required");

const sessionCreate = z.object({
  offering_template_id: uuid,
  resource_id: uuid,
  local_date: localDate,
  local_start_time: localTime,
  capacity: z.number().int().positive().max(10_000).optional(),
});
const sessionPatch = z.object({
  offering_template_id: uuid.optional(),
  resource_id: uuid.optional(),
  local_date: localDate.optional(),
  local_start_time: localTime.optional(),
  capacity: z.number().int().positive().max(10_000).optional(),
}).superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at least one field is required" });
  if ((value.local_date === undefined) !== (value.local_start_time === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "local_date and local_start_time must be supplied together" });
});
const publishBody = z.object({ session_ids: z.array(uuid).min(1).max(500) });

const native = { source: "native" as const, definitionVersion: "scheduling:v1" };

function notFound(entity: string): never {
  throw new ApiError(404, `${entity}_not_found`, `${entity.replaceAll("_", " ")} not found`);
}

async function requireResource(client: Parameters<typeof fetchResource>[0], tenantId: string, id: string) {
  const row = await fetchResource(client, tenantId, id);
  return row ?? notFound("resource");
}

async function requireTemplate(client: Parameters<typeof fetchOfferingTemplate>[0], tenantId: string, id: string) {
  const row = await fetchOfferingTemplate(client, tenantId, id);
  return row ?? notFound("offering_template");
}

function resolvedSessionTimes(local_date: string, local_start_time: string, timezone: string, durationMinutes: number) {
  const starts = localWallTimeToInstant(local_date, local_start_time, timezone);
  return { starts_at: starts.toISOString(), ends_at: new Date(starts.valueOf() + durationMinutes * 60_000).toISOString() };
}

export function registerSchedulingAuthoringRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.get("/scheduling/overview", requireAuth(deps), resolveTenant, async (c) => {
    const { from, to } = parseQuery(c, windowQuery);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const [timezone, resources, readiness, offering_templates, schedule_rules, sessions] = await Promise.all([
      fetchSchedulingTimezone(userClient, tenantId), fetchResources(userClient, tenantId),
      fetchReadiness(userClient, tenantId, from, to), fetchOfferingTemplates(userClient, tenantId),
      fetchScheduleRules(userClient, tenantId), fetchScheduledSessions(userClient, tenantId, from, to),
    ]);
    return c.json(c.var.ok({ timezone, from, to, resources, readiness, offering_templates, schedule_rules, sessions }, native), 200);
  });

  app.get("/scheduling/resources", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ resources: await fetchResources(userClient, tenantId) }, native), 200);
  });
  app.post("/scheduling/resources", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, resourceCreate); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ resource: await createResource(userClient, { tenant_id: tenantId, ...body }) }, native), 201);
  });
  app.patch("/scheduling/resources/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const body = await parseBody(c, resourcePatch); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const resource = await updateResource(userClient, tenantId, id, body);
    return c.json(c.var.ok({ resource: resource ?? notFound("resource") }, native), 200);
  });
  app.delete("/scheduling/resources/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    if (!await deleteAuthoringEntity(userClient, "resources", tenantId, id)) notFound("resource");
    return c.json(c.var.ok({ deleted: true, id }, native), 200);
  });

  app.get("/scheduling/readiness", requireAuth(deps), resolveTenant, async (c) => {
    const query = parseQuery(c, windowQuery); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ readiness: await fetchReadiness(userClient, tenantId, query.from, query.to) }, native), 200);
  });
  app.post("/scheduling/readiness", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, readinessCreate); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    await requireResource(userClient, tenantId, body.resource_id);
    return c.json(c.var.ok({ readiness: await createReadiness(userClient, { tenant_id: tenantId, ...body, effective_to: body.effective_to ?? null, note: body.note ?? null }) }, native), 201);
  });
  app.patch("/scheduling/readiness/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const body = await parseBody(c, readinessPatch); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const readiness = await updateReadiness(userClient, tenantId, id, body);
    return c.json(c.var.ok({ readiness: readiness ?? notFound("readiness") }, native), 200);
  });
  app.delete("/scheduling/readiness/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    if (!await deleteAuthoringEntity(userClient, "resource_readiness", tenantId, id)) notFound("readiness");
    return c.json(c.var.ok({ deleted: true, id }, native), 200);
  });

  app.get("/scheduling/offering-templates", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ offering_templates: await fetchOfferingTemplates(userClient, tenantId) }, native), 200);
  });
  app.post("/scheduling/offering-templates", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, templateCreate); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ offering_template: await createOfferingTemplate(userClient, { tenant_id: tenantId, ...body, default_capacity: body.default_capacity ?? null, kelo_type: body.kelo_type ?? null, description: body.description ?? null }) }, native), 201);
  });
  app.patch("/scheduling/offering-templates/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const body = await parseBody(c, templatePatch); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const offering_template = await updateOfferingTemplate(userClient, tenantId, id, body);
    return c.json(c.var.ok({ offering_template: offering_template ?? notFound("offering_template") }, native), 200);
  });
  app.delete("/scheduling/offering-templates/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    if (!await deleteAuthoringEntity(userClient, "offering_templates", tenantId, id)) notFound("offering_template");
    return c.json(c.var.ok({ deleted: true, id }, native), 200);
  });

  app.get("/scheduling/schedule-rules", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ schedule_rules: await fetchScheduleRules(userClient, tenantId) }, native), 200);
  });
  app.post("/scheduling/schedule-rules", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, ruleCreate); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const [timezone, template, resource] = await Promise.all([fetchSchedulingTimezone(userClient, tenantId), requireTemplate(userClient, tenantId, body.offering_template_id), requireResource(userClient, tenantId, body.resource_id)]);
    expandScheduleRule({ id: crypto.randomUUID(), timezone, end_date: body.end_date ?? null, ...body }, template, resource, { from: body.start_date, to: body.start_date });
    const schedule_rule = await createScheduleRule(userClient, { tenant_id: tenantId, timezone, ...body, end_date: body.end_date ?? null });
    return c.json(c.var.ok({ schedule_rule }, native), 201);
  });
  app.patch("/scheduling/schedule-rules/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const body = await parseBody(c, rulePatch); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const existing = await fetchScheduleRule(userClient, tenantId, id); if (existing === null) notFound("schedule_rule");
    const timezone = await fetchSchedulingTimezone(userClient, tenantId);
    const merged = { ...existing, ...body, timezone };
    const [template, resource] = await Promise.all([requireTemplate(userClient, tenantId, merged.offering_template_id), requireResource(userClient, tenantId, merged.resource_id)]);
    expandScheduleRule(merged, template, resource, { from: merged.start_date, to: merged.start_date });
    const schedule_rule = await updateScheduleRule(userClient, tenantId, id, { ...body, timezone });
    return c.json(c.var.ok({ schedule_rule: schedule_rule ?? notFound("schedule_rule") }, native), 200);
  });
  app.delete("/scheduling/schedule-rules/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    if (!await deleteAuthoringEntity(userClient, "schedule_rules", tenantId, id)) notFound("schedule_rule");
    return c.json(c.var.ok({ deleted: true, id }, native), 200);
  });

  app.get("/scheduling/sessions", requireAuth(deps), resolveTenant, async (c) => {
    const query = parseQuery(c, windowQuery); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const [timezone, sessions] = await Promise.all([fetchSchedulingTimezone(userClient, tenantId), fetchScheduledSessions(userClient, tenantId, query.from, query.to)]);
    return c.json(c.var.ok({ timezone, sessions, ...query }, native), 200);
  });
  app.post("/scheduling/sessions", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, sessionCreate); const { userClient, userId } = authOf(c); const { tenantId } = tenantOf(c);
    const [timezone, template, resource] = await Promise.all([fetchSchedulingTimezone(userClient, tenantId), requireTemplate(userClient, tenantId, body.offering_template_id), requireResource(userClient, tenantId, body.resource_id)]);
    const times = resolvedSessionTimes(body.local_date, body.local_start_time, timezone, template.duration_minutes);
    const session = await createScheduledSession(userClient, { tenant_id: tenantId, offering_template_id: body.offering_template_id, resource_id: body.resource_id, capacity: body.capacity ?? template.default_capacity ?? resource.capacity, status: "draft", schedule_rule_id: null, created_by: userId, published_at: null, ...times });
    return c.json(c.var.ok({ session, timezone, local_date: body.local_date, local_start_time: body.local_start_time }, native), 201);
  });
  const editSession = async (c: Parameters<Parameters<typeof app.post>[2]>[0]) => {
    const { id } = parseParams(c, idParams); const body = await parseBody(c, sessionPatch); const { userClient } = authOf(c); const { tenantId } = tenantOf(c);
    const existing = await fetchScheduledSession(userClient, tenantId, id); if (existing === null) notFound("scheduled_session");
    if (existing.status !== "draft") throw new ApiError(409, "session_not_draft", "only draft sessions can be edited");
    const templateId = body.offering_template_id ?? existing.offering_template_id;
    const resourceId = body.resource_id ?? existing.resource_id;
    const [timezone, template, resource] = await Promise.all([fetchSchedulingTimezone(userClient, tenantId), requireTemplate(userClient, tenantId, templateId), requireResource(userClient, tenantId, resourceId)]);
    const times = body.local_date === undefined ? {} : resolvedSessionTimes(body.local_date, body.local_start_time as string, timezone, template.duration_minutes);
    const session = await updateDraftSession(userClient, tenantId, id, { offering_template_id: templateId, resource_id: resourceId, capacity: body.capacity ?? (body.offering_template_id !== undefined || body.resource_id !== undefined ? template.default_capacity ?? resource.capacity : existing.capacity), ...times });
    return c.json(c.var.ok({ session: session ?? notFound("scheduled_session"), timezone }, native), 200);
  };
  app.patch("/scheduling/sessions/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, editSession);
  app.post("/scheduling/sessions/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, editSession);

  app.post("/scheduling/publish", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { session_ids } = await parseBody(c, publishBody); const { userClient, userId } = authOf(c); const { tenantId } = tenantOf(c);
    const published = await publishSessions(userClient, tenantId, [...new Set(session_ids)], userId);
    return c.json(c.var.ok({ published, requested: session_ids.length }, native), 200);
  });
}
