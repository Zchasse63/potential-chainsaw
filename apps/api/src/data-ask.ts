import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  insert(values: unknown): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  in(column: string, values: readonly unknown[]): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

function rpc(client: KeloSupabaseClient, name: string, params: Record<string, unknown>) {
  return (client as unknown as RpcClient).rpc(name, params);
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

const paramDefinitionSchema = z
  .object({
    type: z.enum(["date", "int", "text"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();

export const askCatalogRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  params_schema: z.record(paramDefinitionSchema),
  metric_keys: z.array(z.string()),
  created_at: z.string().datetime({ offset: true }),
});
export type AskCatalogRow = z.infer<typeof askCatalogRowSchema>;

export async function fetchAskCatalog(client: KeloSupabaseClient): Promise<AskCatalogRow[]> {
  const data = await run(
    from(client, "ask_catalog")
      .select("id, key, version, title, description, params_schema, metric_keys, created_at")
      .order("title", { ascending: true }),
    "fetchAskCatalog",
  );
  return parseInternal(z.array(askCatalogRowSchema), data ?? [], "fetchAskCatalog");
}

const askMissSchema = z.object({ id: z.string().uuid(), created_at: z.string().datetime({ offset: true }) });

export async function insertAskMiss(
  client: KeloSupabaseClient,
  input: { tenant_id: string; question: string; asked_by: string },
): Promise<void> {
  const data = await run(
    from(client, "ask_misses").insert(input).select("id, created_at"),
    "insertAskMiss",
  );
  const rows = parseInternal(z.array(askMissSchema), data ?? [], "insertAskMiss");
  if (rows.length !== 1) throw new Error("insertAskMiss: insert returned no row");
}

const definitionSchema = z.object({ key: z.string(), version: z.number().int(), definition: z.string() });

export async function fetchAskMetricDefinitions(
  client: KeloSupabaseClient,
  keys: readonly string[],
): Promise<Array<z.infer<typeof definitionSchema>>> {
  if (keys.length === 0) return [];
  const data = await run(
    from(client, "metric_definitions")
      .select("key, version, definition")
      .in("key", keys)
      .order("key", { ascending: true })
      .order("version", { ascending: false }),
    "fetchAskMetricDefinitions",
  );
  const rows = parseInternal(z.array(definitionSchema), data ?? [], "fetchAskMetricDefinitions");
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.key) && seen.add(row.key));
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number();
const uuid = z.string().uuid();
const rowSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  revenue_by_period: z.object({ day: dateSchema, gross: money, refunds: money, net: money, txn_count: z.number().int() }),
  revenue_by_tender: z.object({ tender: z.string(), gross: money, refunds: money, net: money, txn_count: z.number().int() }),
  mrr_current: z.object({ mrr: money, contributing_members: z.number().int(), excluded_partner: z.number().int() }),
  attendance_by_period: z.object({ attended: z.number().int(), no_show: z.number().int(), late_cancel: z.number().int(), attendance_rate: z.number(), no_show_rate: z.number() }),
  top_customers_by_revenue: z.object({ person_id: uuid, collected: money }),
  fill_rate_by_daypart: z.object({ dow: z.number().int(), daypart: z.string(), sessions: z.number().int(), booked: z.number().int(), capacity: z.number().int(), fill: z.number() }),
  credits_expiring_people: z.object({ person_id: uuid, balance: z.number().int(), next_expiry: z.string().datetime({ offset: true }) }),
  failed_payments_outstanding: z.object({ failed_count: z.number().int(), failed_sum: money, people: z.number().int() }),
  segment_membership_current: z.object({ segment_key: z.string(), person_id: uuid, priority: z.number().int(), rule_version: z.number().int(), evidence: z.record(z.unknown()) }),
  booking_channel_mix: z.object({ channel: z.string(), bookings: z.number().int() }),
  new_people_by_week: z.object({ week: dateSchema, new_people: z.number().int() }),
};

function requiredParam<T>(params: Record<string, unknown>, key: string): T {
  if (!(key in params)) throw new Error(`validated catalog parameter ${key} is missing`);
  return params[key] as T;
}

const RPC_BY_KEY: Record<string, { name: string; params: (tenantId: string, values: Record<string, unknown>) => Record<string, unknown> }> = {
  revenue_by_period: { name: "kpi_collected_revenue", params: (tenant, p) => ({ p_tenant: tenant, p_from: requiredParam(p, "from"), p_to: requiredParam(p, "to") }) },
  revenue_by_tender: { name: "ask_revenue_by_tender", params: (tenant, p) => ({ p_tenant: tenant, p_from: requiredParam(p, "from"), p_to: requiredParam(p, "to") }) },
  mrr_current: { name: "kpi_mrr", params: (tenant) => ({ p_tenant: tenant }) },
  attendance_by_period: { name: "kpi_attendance", params: (tenant, p) => ({ p_tenant: tenant, p_from: requiredParam(p, "from"), p_to: requiredParam(p, "to") }) },
  top_customers_by_revenue: { name: "ask_top_customers", params: (tenant, p) => ({ p_tenant: tenant, p_from: requiredParam(p, "from"), p_to: requiredParam(p, "to"), p_limit: requiredParam(p, "limit") }) },
  fill_rate_by_daypart: { name: "ask_fill_rate_by_daypart", params: (tenant, p) => ({ p_tenant: tenant, p_from: requiredParam(p, "from"), p_to: requiredParam(p, "to") }) },
  credits_expiring_people: { name: "ask_credits_expiring", params: (tenant, p) => ({ p_tenant: tenant, p_days: requiredParam(p, "days") }) },
  failed_payments_outstanding: { name: "kpi_failed_payments", params: (tenant, p) => ({ p_tenant: tenant, p_days: requiredParam(p, "days") }) },
  segment_membership_current: { name: "segment_current", params: (tenant) => ({ p_tenant: tenant }) },
  booking_channel_mix: { name: "ask_booking_channel_mix", params: (tenant, p) => ({ p_tenant: tenant, p_from: requiredParam(p, "from"), p_to: requiredParam(p, "to") }) },
  new_people_by_week: { name: "ask_new_people_by_week", params: (tenant, p) => ({ p_tenant: tenant, p_weeks: requiredParam(p, "weeks") }) },
};

export async function executeAskCatalog(
  client: KeloSupabaseClient,
  tenantId: string,
  key: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  if (key === "member_count_current") {
    const data = await run(rpc(client, "kpi_member_count", { p_tenant: tenantId }), "executeAskCatalog member_count_current");
    return [{ member_count: parseInternal(z.number().int(), data, "executeAskCatalog member_count_current") }];
  }
  const definition = RPC_BY_KEY[key];
  const schema = rowSchemas[key];
  if (definition === undefined || schema === undefined) throw new Error(`catalog key ${key} has no fixed executor`);
  const data = await run(rpc(client, definition.name, definition.params(tenantId, params)), `executeAskCatalog ${key}`);
  return parseInternal(z.array(schema), data ?? [], `executeAskCatalog ${key}`);
}

const personNameSchema = z.object({ id: uuid, first_name: z.string().nullable(), last_name: z.string().nullable() });

export async function resolveAskPersonNames(
  client: KeloSupabaseClient,
  tenantId: string,
  rows: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(rows.map((row) => row["person_id"]).filter((id): id is string => typeof id === "string"))];
  if (ids.length === 0) return [...rows];
  const data = await run(
    from(client, "people").select("id, first_name, last_name").eq("tenant_id", tenantId).in("id", ids),
    "resolveAskPersonNames",
  );
  const people = parseInternal(z.array(personNameSchema), data ?? [], "resolveAskPersonNames");
  const byId = new Map(people.map((person) => [person.id, person]));
  return rows.map((row) => {
    const id = row["person_id"];
    const person = typeof id === "string" ? byId.get(id) : undefined;
    return person === undefined ? { ...row } : { ...row, first_name: person.first_name, last_name: person.last_name };
  });
}

export const heatmapRowSchema = rowSchemas["fill_rate_by_daypart"] as z.ZodType<{
  dow: number; daypart: string; sessions: number; booked: number; capacity: number; fill: number;
}>;
export const heatmapSessionSchema = z.object({
  dow: z.number().int(), daypart: z.string(), session_id: uuid, name: z.string().nullable(),
  time_start: z.string().datetime({ offset: true }), booked: z.number().int(), capacity: z.number().int(),
});

export async function fetchScheduleHeatmap(client: KeloSupabaseClient, tenantId: string, fromDate: string, toDate: string) {
  const [aggregate, sessions] = await Promise.all([
    run(rpc(client, "ask_fill_rate_by_daypart", { p_tenant: tenantId, p_from: fromDate, p_to: toDate }), "fetchScheduleHeatmap aggregate"),
    run(rpc(client, "ask_schedule_sessions", { p_tenant: tenantId, p_from: fromDate, p_to: toDate }), "fetchScheduleHeatmap sessions"),
  ]);
  const cells = parseInternal(z.array(heatmapRowSchema), aggregate ?? [], "fetchScheduleHeatmap aggregate");
  const details = parseInternal(z.array(heatmapSessionSchema), sessions ?? [], "fetchScheduleHeatmap sessions");
  return cells.map((cell) => ({
    ...cell,
    underlying_sessions: details.filter((session) => session.dow === cell.dow && session.daypart === cell.daypart),
  }));
}
