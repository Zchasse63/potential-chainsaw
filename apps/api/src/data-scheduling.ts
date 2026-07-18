import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

interface QueryError { message: string; code?: string }
interface QueryResult { data: unknown; error: QueryError | null }

interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  insert(values: unknown): TableBuilder;
  update(values: unknown): TableBuilder;
  delete(): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  in(column: string, values: readonly unknown[]): TableBuilder;
  gte(column: string, value: unknown): TableBuilder;
  gt(column: string, value: unknown): TableBuilder;
  lt(column: string, value: unknown): TableBuilder;
  or(filters: string): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

async function run(query: PromiseLike<QueryResult>, label: string): Promise<unknown> {
  const { data, error } = await query;
  if (error !== null) throw new Error(`${label} query failed: ${error.message}`);
  return data;
}

function parseInternal<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  return parsed.data;
}

const uuid = z.string().uuid();
const timestamp = z.string().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const resourceKindSchema = z.enum(["room", "equipment", "trainer_slot"]);
export const readinessStateSchema = z.enum(["ready", "turnover", "maintenance", "closed"]);
export const sessionStatusSchema = z.enum(["draft", "published", "cancelled"]);

export const resourceSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: resourceKindSchema,
  capacity: z.number().int().positive(),
  active: z.boolean(),
  created_at: timestamp,
});
export type ResourceRow = z.infer<typeof resourceSchema>;

export const readinessSchema = z.object({
  id: uuid,
  resource_id: uuid,
  state: readinessStateSchema,
  effective_from: timestamp,
  effective_to: timestamp.nullable(),
  note: z.string().nullable(),
  created_at: timestamp,
});
export type ReadinessRow = z.infer<typeof readinessSchema>;

export const offeringTemplateSchema = z.object({
  id: uuid,
  name: z.string(),
  duration_minutes: z.number().int().positive(),
  default_capacity: z.number().int().positive().nullable(),
  kelo_type: z.string().nullable(),
  description: z.string().nullable(),
  active: z.boolean(),
  created_at: timestamp,
});
export type OfferingTemplateRow = z.infer<typeof offeringTemplateSchema>;

export const scheduleRuleSchema = z.object({
  id: uuid,
  offering_template_id: uuid,
  resource_id: uuid,
  rrule: z.string(),
  local_start_time: z.string(),
  timezone: z.string(),
  start_date: date,
  end_date: date.nullable(),
  active: z.boolean(),
  created_at: timestamp,
});
export type ScheduleRuleRow = z.infer<typeof scheduleRuleSchema>;

export const scheduledSessionSchema = z.object({
  id: uuid,
  offering_template_id: uuid,
  resource_id: uuid,
  starts_at: timestamp,
  ends_at: timestamp,
  capacity: z.number().int().positive(),
  status: sessionStatusSchema,
  schedule_rule_id: uuid.nullable(),
  created_by: uuid.nullable(),
  published_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type ScheduledSessionRow = z.infer<typeof scheduledSessionSchema>;

const RESOURCE_COLUMNS = "id, name, kind, capacity, active, created_at";
const READINESS_COLUMNS = "id, resource_id, state, effective_from, effective_to, note, created_at";
const TEMPLATE_COLUMNS = "id, name, duration_minutes, default_capacity, kelo_type, description, active, created_at";
const RULE_COLUMNS = "id, offering_template_id, resource_id, rrule, local_start_time, timezone, start_date, end_date, active, created_at";
const SESSION_COLUMNS = "id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, schedule_rule_id, created_by, published_at, created_at, updated_at";

async function rows<S extends z.ZodTypeAny>(query: TableBuilder, schema: S, label: string): Promise<z.output<S>[]> {
  const data = await run(query, label);
  return parseInternal(z.array(schema), data ?? [], label);
}

export async function fetchSchedulingTimezone(client: KeloSupabaseClient, tenantId: string): Promise<string> {
  const result = await run(
    from(client, "locations").select("timezone").eq("tenant_id", tenantId)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1),
    "fetchSchedulingTimezone",
  );
  const locations = parseInternal(z.array(z.object({ timezone: z.string().min(1) })), result ?? [], "fetchSchedulingTimezone");
  const location = locations[0];
  if (location === undefined) throw new Error("fetchSchedulingTimezone: tenant has no location");
  assertTimeZone(location.timezone);
  return location.timezone;
}

export async function fetchResources(client: KeloSupabaseClient, tenantId: string): Promise<ResourceRow[]> {
  return rows(from(client, "resources").select(RESOURCE_COLUMNS).eq("tenant_id", tenantId).order("name"), resourceSchema, "fetchResources");
}

export async function fetchResource(client: KeloSupabaseClient, tenantId: string, id: string): Promise<ResourceRow | null> {
  return (await rows(from(client, "resources").select(RESOURCE_COLUMNS).eq("tenant_id", tenantId).eq("id", id).limit(1), resourceSchema, "fetchResource"))[0] ?? null;
}

export async function createResource(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<ResourceRow> {
  const result = await rows(from(client, "resources").insert(input).select(RESOURCE_COLUMNS), resourceSchema, "createResource");
  const row = result[0];
  if (row === undefined) throw new Error("createResource: insert returned no row");
  return row;
}

export async function updateResource(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<ResourceRow | null> {
  return (await rows(from(client, "resources").update(patch).eq("tenant_id", tenantId).eq("id", id).select(RESOURCE_COLUMNS), resourceSchema, "updateResource"))[0] ?? null;
}

export async function fetchReadiness(client: KeloSupabaseClient, tenantId: string, fromInstant?: string, toInstant?: string): Promise<ReadinessRow[]> {
  let query = from(client, "resource_readiness").select(READINESS_COLUMNS).eq("tenant_id", tenantId);
  if (toInstant !== undefined) query = query.lt("effective_from", toInstant);
  if (fromInstant !== undefined) query = query.or(`effective_to.is.null,effective_to.gt.${fromInstant}`);
  return rows(query.order("effective_from"), readinessSchema, "fetchReadiness");
}

export async function createReadiness(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<ReadinessRow> {
  const result = await rows(from(client, "resource_readiness").insert(input).select(READINESS_COLUMNS), readinessSchema, "createReadiness");
  const row = result[0];
  if (row === undefined) throw new Error("createReadiness: insert returned no row");
  return row;
}

export async function updateReadiness(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<ReadinessRow | null> {
  return (await rows(from(client, "resource_readiness").update(patch).eq("tenant_id", tenantId).eq("id", id).select(READINESS_COLUMNS), readinessSchema, "updateReadiness"))[0] ?? null;
}

export async function fetchOfferingTemplates(client: KeloSupabaseClient, tenantId: string): Promise<OfferingTemplateRow[]> {
  return rows(from(client, "offering_templates").select(TEMPLATE_COLUMNS).eq("tenant_id", tenantId).order("name"), offeringTemplateSchema, "fetchOfferingTemplates");
}

export async function fetchOfferingTemplate(client: KeloSupabaseClient, tenantId: string, id: string): Promise<OfferingTemplateRow | null> {
  return (await rows(from(client, "offering_templates").select(TEMPLATE_COLUMNS).eq("tenant_id", tenantId).eq("id", id).limit(1), offeringTemplateSchema, "fetchOfferingTemplate"))[0] ?? null;
}

export async function createOfferingTemplate(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<OfferingTemplateRow> {
  const result = await rows(from(client, "offering_templates").insert(input).select(TEMPLATE_COLUMNS), offeringTemplateSchema, "createOfferingTemplate");
  const row = result[0];
  if (row === undefined) throw new Error("createOfferingTemplate: insert returned no row");
  return row;
}

export async function updateOfferingTemplate(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<OfferingTemplateRow | null> {
  return (await rows(from(client, "offering_templates").update(patch).eq("tenant_id", tenantId).eq("id", id).select(TEMPLATE_COLUMNS), offeringTemplateSchema, "updateOfferingTemplate"))[0] ?? null;
}

export async function fetchScheduleRules(client: KeloSupabaseClient, tenantId: string): Promise<ScheduleRuleRow[]> {
  return rows(from(client, "schedule_rules").select(RULE_COLUMNS).eq("tenant_id", tenantId).order("created_at"), scheduleRuleSchema, "fetchScheduleRules");
}

export async function fetchScheduleRule(client: KeloSupabaseClient, tenantId: string, id: string): Promise<ScheduleRuleRow | null> {
  return (await rows(from(client, "schedule_rules").select(RULE_COLUMNS).eq("tenant_id", tenantId).eq("id", id).limit(1), scheduleRuleSchema, "fetchScheduleRule"))[0] ?? null;
}

export async function createScheduleRule(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<ScheduleRuleRow> {
  const result = await rows(from(client, "schedule_rules").insert(input).select(RULE_COLUMNS), scheduleRuleSchema, "createScheduleRule");
  const row = result[0];
  if (row === undefined) throw new Error("createScheduleRule: insert returned no row");
  return row;
}

export async function updateScheduleRule(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<ScheduleRuleRow | null> {
  return (await rows(from(client, "schedule_rules").update(patch).eq("tenant_id", tenantId).eq("id", id).select(RULE_COLUMNS), scheduleRuleSchema, "updateScheduleRule"))[0] ?? null;
}

export async function fetchScheduledSessions(client: KeloSupabaseClient, tenantId: string, fromInstant: string, toInstant: string): Promise<ScheduledSessionRow[]> {
  return rows(from(client, "scheduled_sessions").select(SESSION_COLUMNS).eq("tenant_id", tenantId).gte("starts_at", fromInstant).lt("starts_at", toInstant).order("starts_at"), scheduledSessionSchema, "fetchScheduledSessions");
}

export async function fetchScheduledSession(client: KeloSupabaseClient, tenantId: string, id: string): Promise<ScheduledSessionRow | null> {
  return (await rows(from(client, "scheduled_sessions").select(SESSION_COLUMNS).eq("tenant_id", tenantId).eq("id", id).limit(1), scheduledSessionSchema, "fetchScheduledSession"))[0] ?? null;
}

export async function createScheduledSession(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<ScheduledSessionRow> {
  const result = await rows(from(client, "scheduled_sessions").insert(input).select(SESSION_COLUMNS), scheduledSessionSchema, "createScheduledSession");
  const row = result[0];
  if (row === undefined) throw new Error("createScheduledSession: insert returned no row");
  return row;
}

export async function updateDraftSession(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<ScheduledSessionRow | null> {
  return (await rows(from(client, "scheduled_sessions").update(patch).eq("tenant_id", tenantId).eq("id", id).eq("status", "draft").select(SESSION_COLUMNS), scheduledSessionSchema, "updateDraftSession"))[0] ?? null;
}

export async function deleteAuthoringEntity(client: KeloSupabaseClient, table: "resources" | "resource_readiness" | "offering_templates" | "schedule_rules", tenantId: string, id: string): Promise<boolean> {
  const data = await run(from(client, table).delete().eq("tenant_id", tenantId).eq("id", id).select("id"), `delete ${table}`);
  return parseInternal(z.array(z.object({ id: uuid })), data ?? [], `delete ${table}`).length > 0;
}

export async function publishSessions(client: KeloSupabaseClient, tenantId: string, sessionIds: string[], actorId: string): Promise<number> {
  const { data, error } = await (client as unknown as RpcClient).rpc("publish_sessions", {
    p_tenant: tenantId,
    p_session_ids: sessionIds,
    p_actor: actorId,
  });
  if (error !== null) {
    if (error.code === "42501") throw new ApiError(403, "publish_forbidden", "database authorization denied schedule publication");
    throw new Error(`publish_sessions RPC failed: ${error.message}`);
  }
  return parseInternal(z.number().int().nonnegative(), data, "publishSessions");
}

// -- DST-safe schedule-rule expansion ---------------------------------------

const LOCAL_TIME = /^(\d{2}):(\d{2})$/;
const ICAL_DATE = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/;
const WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new ApiError(422, "invalid_timezone", "timezone must be a valid IANA timezone");
  }
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second")) - utcMs;
}

/**
 * The same two-pass Intl offset refinement used by the Glofox branch mapper,
 * with a round-trip guard so an authored nonexistent spring-forward wall time
 * is rejected instead of silently changing its displayed hour.
 */
export function localWallTimeToInstant(localDate: string, localTime: string, timeZone: string): Date {
  assertTimeZone(timeZone);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = LOCAL_TIME.exec(localTime);
  if (dateMatch === null || timeMatch === null) throw new ApiError(422, "invalid_wall_time", "local date and time must use YYYY-MM-DD and HH:MM");
  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const wallAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const firstOffset = zoneOffsetMs(wallAsUtc, timeZone);
  const secondOffset = zoneOffsetMs(wallAsUtc - firstOffset, timeZone);
  const instant = new Date(wallAsUtc - secondOffset);
  const roundTrip = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => roundTrip.find((entry) => entry.type === type)?.value;
  if (`${part("year")}-${part("month")}-${part("day")}` !== localDate || `${part("hour")}:${part("minute")}` !== localTime) {
    throw new ApiError(422, "nonexistent_wall_time", `${localDate} ${localTime} does not exist in ${timeZone} because of a timezone transition`);
  }
  return instant;
}

function parseDate(value: string): Date {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`invalid schedule date: ${value}`);
  return parsed;
}

function isoDate(value: Date): string { return value.toISOString().slice(0, 10); }
function addDays(value: Date, amount: number): Date { const next = new Date(value); next.setUTCDate(next.getUTCDate() + amount); return next; }
function dayDiff(left: Date, right: Date): number { return Math.round((left.valueOf() - right.valueOf()) / 86_400_000); }

interface ParsedRRule {
  frequency: "DAILY" | "WEEKLY";
  interval: number;
  byDay: Set<string> | null;
  count: number | null;
  until: string | null;
}

function parseRRule(value: string): ParsedRRule {
  const text = value.trim().replace(/^RRULE:/i, "");
  const fields = new Map(text.split(";").map((field) => {
    const [key, item, ...rest] = field.split("=");
    if (key === undefined || item === undefined || rest.length > 0) throw new Error("invalid RRULE field");
    return [key.toUpperCase(), item.toUpperCase()] as const;
  }));
  const frequency = fields.get("FREQ");
  if (frequency !== "DAILY" && frequency !== "WEEKLY") throw new ApiError(422, "unsupported_rrule", "schedule rules support FREQ=DAILY or FREQ=WEEKLY");
  const interval = Number(fields.get("INTERVAL") ?? "1");
  const count = fields.has("COUNT") ? Number(fields.get("COUNT")) : null;
  if (!Number.isInteger(interval) || interval <= 0 || (count !== null && (!Number.isInteger(count) || count <= 0))) throw new ApiError(422, "invalid_rrule", "RRULE INTERVAL and COUNT must be positive integers");
  const byDay = fields.has("BYDAY") ? new Set(fields.get("BYDAY")?.split(",")) : null;
  if (byDay !== null && [...byDay].some((entry) => !(WEEKDAY as readonly string[]).includes(entry))) throw new ApiError(422, "unsupported_rrule", "RRULE BYDAY must contain two-letter weekdays without ordinals");
  const rawUntil = fields.get("UNTIL");
  let until: string | null = null;
  if (rawUntil !== undefined) {
    const match = ICAL_DATE.exec(rawUntil);
    if (match === null) throw new ApiError(422, "invalid_rrule", "RRULE UNTIL must use an iCalendar date");
    until = `${match[1]}-${match[2]}-${match[3]}`;
    parseDate(until);
  }
  return { frequency, interval, byDay, count, until };
}

export interface ExpandedSession {
  offering_template_id: string;
  resource_id: string;
  schedule_rule_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: "draft";
}

export function expandScheduleRule(
  rule: Pick<ScheduleRuleRow, "id" | "offering_template_id" | "resource_id" | "rrule" | "local_start_time" | "timezone" | "start_date" | "end_date" | "active">,
  template: Pick<OfferingTemplateRow, "duration_minutes" | "default_capacity">,
  resource: Pick<ResourceRow, "capacity">,
  horizon: { from: string; to: string },
): ExpandedSession[] {
  if (!rule.active) return [];
  const parsed = parseRRule(rule.rrule);
  const ruleStart = parseDate(rule.start_date);
  const horizonStart = parseDate(horizon.from);
  const horizonEnd = parseDate(horizon.to);
  if (horizonEnd < horizonStart) throw new Error("expansion horizon must end on or after it starts");
  if (dayDiff(horizonEnd, horizonStart) > 55) throw new ApiError(422, "horizon_too_large", "rule expansion horizon may not exceed 8 weeks");
  const finalDate = [rule.end_date, parsed.until, horizon.to].filter((value): value is string => value !== null).sort()[0] ?? horizon.to;
  const upper = parseDate(finalDate);
  const output: ExpandedSession[] = [];
  let occurrenceCount = 0;

  for (let cursor = ruleStart; cursor <= upper; cursor = addDays(cursor, 1)) {
    const diff = dayDiff(cursor, ruleStart);
    const weekday = WEEKDAY[cursor.getUTCDay()];
    const matches = parsed.frequency === "DAILY"
      ? diff % parsed.interval === 0 && (parsed.byDay === null || parsed.byDay.has(weekday))
      : Math.floor(diff / 7) % parsed.interval === 0 && (parsed.byDay?.has(weekday) ?? cursor.getUTCDay() === ruleStart.getUTCDay());
    if (!matches) continue;
    occurrenceCount += 1;
    if (parsed.count !== null && occurrenceCount > parsed.count) break;
    if (cursor < horizonStart) continue;
    const starts = localWallTimeToInstant(isoDate(cursor), rule.local_start_time, rule.timezone);
    output.push({
      offering_template_id: rule.offering_template_id,
      resource_id: rule.resource_id,
      schedule_rule_id: rule.id,
      starts_at: starts.toISOString(),
      ends_at: new Date(starts.valueOf() + template.duration_minutes * 60_000).toISOString(),
      capacity: template.default_capacity ?? resource.capacity,
      status: "draft",
    });
  }
  return output;
}
