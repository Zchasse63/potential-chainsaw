import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";

interface QueryError {
  message: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

interface DefinitionBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): DefinitionBuilder;
  order(column: string, options?: { ascending?: boolean }): DefinitionBuilder;
}

function rpc(client: KeloSupabaseClient, name: string, params: Record<string, unknown>) {
  return (client as unknown as RpcClient).rpc(name, params);
}

function definitions(client: KeloSupabaseClient): DefinitionBuilder {
  return client.from("metric_definitions") as unknown as DefinitionBuilder;
}

async function run(query: PromiseLike<QueryResult>, label: string): Promise<unknown> {
  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`${label} query failed: ${error.message}`);
  }
  return data;
}

function parseInternal<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  label: string,
): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  }
  return parsed.data;
}

function firstRow<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  const rows = parseInternal(z.array(schema), data ?? [], label);
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`${label}: function returned no row`);
  }
  return first;
}

const dbDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reportDatesSchema = z.object({
  today: dbDateSchema,
  from_7d: dbDateSchema,
  from_30d: dbDateSchema,
});
export type ReportDates = z.infer<typeof reportDatesSchema>;

const moneySchema = z.number();

export const collectedRevenueRowSchema = z.object({
  day: dbDateSchema,
  gross: moneySchema,
  refunds: moneySchema,
  net: moneySchema,
  txn_count: z.number().int(),
});
export type CollectedRevenueRow = z.infer<typeof collectedRevenueRowSchema>;

export const collectedRevenueTotalsSchema = collectedRevenueRowSchema.omit({ day: true });
export type CollectedRevenueTotals = z.infer<typeof collectedRevenueTotalsSchema>;

export const mrrSchema = z.object({
  mrr: moneySchema,
  contributing_members: z.number().int(),
  excluded_partner: z.number().int(),
});
export type Mrr = z.infer<typeof mrrSchema>;

export const attendanceSchema = z.object({
  attended: z.number().int(),
  no_show: z.number().int(),
  late_cancel: z.number().int(),
  attendance_rate: z.number(),
  no_show_rate: z.number(),
});
export type Attendance = z.infer<typeof attendanceSchema>;

export const creditLiabilitySchema = z.object({
  outstanding_credits: z.number().int(),
  est_liability: moneySchema,
  approximate: z.boolean(),
});
export type CreditLiability = z.infer<typeof creditLiabilitySchema>;

export const failedPaymentsSchema = z.object({
  failed_count: z.number().int(),
  failed_sum: moneySchema,
  people: z.number().int(),
});
export type FailedPayments = z.infer<typeof failedPaymentsSchema>;

export const metricDefinitionSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  version: z.number().int().positive(),
  definition: z.string(),
  notes: z.string().nullable(),
  effective_from: z.string().datetime({ offset: true }),
  created_at: z.string().datetime({ offset: true }),
});
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export async function fetchReportDates(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<ReportDates> {
  const data = await run(
    rpc(client, "kpi_report_dates", { p_tenant: tenantId }),
    "fetchReportDates",
  );
  return firstRow(reportDatesSchema, data, "fetchReportDates");
}

export async function fetchMemberCount(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<number> {
  const data = await run(
    rpc(client, "kpi_member_count", { p_tenant: tenantId }),
    "fetchMemberCount",
  );
  return parseInternal(z.number().int(), data, "fetchMemberCount");
}

export async function fetchMrr(client: KeloSupabaseClient, tenantId: string): Promise<Mrr> {
  const data = await run(rpc(client, "kpi_mrr", { p_tenant: tenantId }), "fetchMrr");
  return firstRow(mrrSchema, data, "fetchMrr");
}

export async function fetchCollectedRevenue(
  client: KeloSupabaseClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<CollectedRevenueRow[]> {
  const data = await run(
    rpc(client, "kpi_collected_revenue", {
      p_tenant: tenantId,
      p_from: from,
      p_to: to,
    }),
    "fetchCollectedRevenue",
  );
  return parseInternal(z.array(collectedRevenueRowSchema), data ?? [], "fetchCollectedRevenue");
}

export async function fetchCollectedRevenueTotals(
  client: KeloSupabaseClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<CollectedRevenueTotals> {
  const data = await run(
    rpc(client, "kpi_collected_revenue_totals", {
      p_tenant: tenantId,
      p_from: from,
      p_to: to,
    }),
    "fetchCollectedRevenueTotals",
  );
  return firstRow(collectedRevenueTotalsSchema, data, "fetchCollectedRevenueTotals");
}

export async function fetchAttendance(
  client: KeloSupabaseClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<Attendance> {
  const data = await run(
    rpc(client, "kpi_attendance", {
      p_tenant: tenantId,
      p_from: from,
      p_to: to,
    }),
    "fetchAttendance",
  );
  return firstRow(attendanceSchema, data, "fetchAttendance");
}

export async function fetchCreditLiability(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<CreditLiability> {
  const data = await run(
    rpc(client, "kpi_credit_liability", { p_tenant: tenantId }),
    "fetchCreditLiability",
  );
  return firstRow(creditLiabilitySchema, data, "fetchCreditLiability");
}

export async function fetchFailedPayments(
  client: KeloSupabaseClient,
  tenantId: string,
  days: number,
): Promise<FailedPayments> {
  const data = await run(
    rpc(client, "kpi_failed_payments", { p_tenant: tenantId, p_days: days }),
    "fetchFailedPayments",
  );
  return firstRow(failedPaymentsSchema, data, "fetchFailedPayments");
}

export async function fetchMetricDefinitions(
  client: KeloSupabaseClient,
): Promise<MetricDefinition[]> {
  const data = await run(
    definitions(client)
      .select("id, key, version, definition, notes, effective_from, created_at")
      .order("key", { ascending: true })
      .order("version", { ascending: true }),
    "fetchMetricDefinitions",
  );
  return parseInternal(z.array(metricDefinitionSchema), data ?? [], "fetchMetricDefinitions");
}
