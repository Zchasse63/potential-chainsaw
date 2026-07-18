import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { fetchFailedPayments, type FailedPayments } from "./data-reports.js";

interface QueryError {
  message: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
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

const timezoneRowSchema = z.object({ timezone: z.string().min(1) });

export async function fetchStudioTimezone(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<string> {
  const data = await run(
    from(client, "locations")
      .select("timezone")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1),
    "fetchStudioTimezone",
  );
  const rows = parseInternal(z.array(timezoneRowSchema), data ?? [], "fetchStudioTimezone");
  const row = rows[0];
  if (row === undefined) throw new Error("fetchStudioTimezone: tenant has no location");
  return row.timezone;
}

export function studioBusinessDate(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("could not compute studio-local business date");
  }
  return `${year}-${month}-${day}`;
}

export function previousBusinessDate(date: string): string {
  const previous = new Date(`${date}T12:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

export const briefingArtifactSchema = z.object({
  id: z.string().uuid(),
  generated_for: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["generated", "fallback", "refused"]),
  prompt_version: z.number().int().nullable(),
  model: z.string().nullable(),
  input: z.unknown(),
  input_hash: z.string(),
  output: z.unknown().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
});
export type BriefingArtifactRow = z.infer<typeof briefingArtifactSchema>;

const ARTIFACT_COLUMNS =
  "id, generated_for, status, prompt_version, model, input, input_hash, output, cost_usd, error, created_at";

export async function fetchBriefingArtifact(
  client: KeloSupabaseClient,
  tenantId: string,
  generatedFor: string,
): Promise<BriefingArtifactRow | null> {
  const data = await run(
    from(client, "ai_artifacts")
      .select(ARTIFACT_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("kind", "briefing")
      .eq("generated_for", generatedFor)
      .limit(1),
    "fetchBriefingArtifact",
  );
  const rows = parseInternal(z.array(briefingArtifactSchema), data ?? [], "fetchBriefingArtifact");
  return rows[0] ?? null;
}

const briefingArchiveRowSchema = briefingArtifactSchema.pick({
  id: true,
  generated_for: true,
  status: true,
  output: true,
});
export type BriefingArchiveRow = z.infer<typeof briefingArchiveRowSchema>;

export async function fetchBriefingArchive(
  client: KeloSupabaseClient,
  tenantId: string,
  limit: number,
): Promise<BriefingArchiveRow[]> {
  const data = await run(
    from(client, "ai_artifacts")
      .select("id, generated_for, status, output")
      .eq("tenant_id", tenantId)
      .eq("kind", "briefing")
      .order("generated_for", { ascending: false })
      .limit(limit),
    "fetchBriefingArchive",
  );
  return parseInternal(z.array(briefingArchiveRowSchema), data ?? [], "fetchBriefingArchive");
}

const feedbackRowSchema = z.object({
  id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  item_ref: z.string(),
  verdict: z.enum(["up", "down"]),
  reason: z.string().nullable(),
  actor_user_id: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type BriefingFeedbackRow = z.infer<typeof feedbackRowSchema>;

export async function insertBriefingFeedback(
  client: KeloSupabaseClient,
  input: {
    tenant_id: string;
    artifact_id: string;
    item_ref: string;
    verdict: "up" | "down";
    reason?: string;
    actor_user_id: string;
  },
): Promise<BriefingFeedbackRow> {
  const data = await run(
    from(client, "briefing_feedback")
      .insert({ ...input, reason: input.reason ?? null })
      .select("id, artifact_id, item_ref, verdict, reason, actor_user_id, created_at"),
    "insertBriefingFeedback",
  );
  const rows = parseInternal(z.array(feedbackRowSchema), data ?? [], "insertBriefingFeedback");
  const row = rows[0];
  if (row === undefined) throw new Error("insertBriefingFeedback: insert returned no row");
  return row;
}

const segmentCurrentSchema = z.object({
  segment_key: z.string(),
  person_id: z.string().uuid(),
  priority: z.number().int(),
  rule_version: z.number().int(),
  evidence: z.record(z.unknown()),
});

const personSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
});

const dismissalSchema = z.object({
  item_key: z.string(),
  action: z.enum(["dismissed", "snoozed"]),
  snooze_until: z.string().nullable(),
  created_at: z.string(),
});

export interface FocusQueueItem {
  item_key: string;
  category: "payment_risk" | "at_risk" | "credits_expiring" | "hooked";
  person_id: string;
  facts: Record<string, unknown>;
}

function isFocusCategory(value: string): value is FocusQueueItem["category"] {
  return ["payment_risk", "at_risk", "credits_expiring", "hooked"].includes(value);
}

export async function fetchFocusQueue(
  client: KeloSupabaseClient,
  tenantId: string,
  now = new Date(),
): Promise<FocusQueueItem[]> {
  const [segmentsData, failedPayments, dismissalsData] = await Promise.all([
    run(rpc(client, "segment_current", { p_tenant: tenantId }), "fetchFocusQueue segments"),
    fetchFailedPayments(client, tenantId, 30),
    run(
      from(client, "focus_dismissals")
        .select("item_key, action, snooze_until, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }),
      "fetchFocusQueue dismissals",
    ),
  ]);
  const allSegments = parseInternal(
    z.array(segmentCurrentSchema),
    segmentsData ?? [],
    "fetchFocusQueue segments",
  );
  const segments = allSegments.flatMap((row) =>
    isFocusCategory(row.segment_key)
      ? [{ ...row, segment_key: row.segment_key }]
      : [],
  );
  const dismissals = parseInternal(
    z.array(dismissalSchema),
    dismissalsData ?? [],
    "fetchFocusQueue dismissals",
  );
  const hidden = new Set(
    dismissals
      .filter(
        (row) =>
          row.action === "dismissed" ||
          (row.snooze_until !== null && new Date(row.snooze_until).valueOf() > now.valueOf()),
      )
      .map((row) => row.item_key),
  );
  const personIds = [...new Set(segments.map((row) => row.person_id))];
  const peopleData =
    personIds.length === 0
      ? []
      : await run(
          from(client, "people")
            .select("id, first_name, last_name")
            .eq("tenant_id", tenantId)
            .in("id", personIds),
          "fetchFocusQueue people",
        );
  const people = parseInternal(z.array(personSchema), peopleData ?? [], "fetchFocusQueue people");
  const peopleById = new Map(people.map((person) => [person.id, person]));

  return segments.flatMap((row) => {
    const itemKey = `${row.segment_key}:${row.person_id}`;
    if (
      hidden.has(itemKey) ||
      (row.segment_key === "payment_risk" && failedPayments.failed_sum <= 0)
    ) {
      return [];
    }
    const person = peopleById.get(row.person_id);
    const paymentFacts: { failed_payments?: FailedPayments } =
      row.segment_key === "payment_risk" ? { failed_payments: failedPayments } : {};
    return [
      {
        item_key: itemKey,
        category: row.segment_key,
        person_id: row.person_id,
        facts: {
          ...row.evidence,
          ...paymentFacts,
          first_name: person?.first_name ?? null,
          last_name: person?.last_name ?? null,
        },
      },
    ];
  });
}

const focusDismissalRowSchema = z.object({
  id: z.string().uuid(),
  item_key: z.string(),
  action: z.enum(["dismissed", "snoozed"]),
  reason: z.string().nullable(),
  snooze_until: z.string().nullable(),
  actor_user_id: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type FocusDismissalRow = z.infer<typeof focusDismissalRowSchema>;

export async function insertFocusDismissal(
  client: KeloSupabaseClient,
  input: {
    tenant_id: string;
    item_key: string;
    action: "dismissed" | "snoozed";
    reason?: string;
    snooze_until?: string;
    actor_user_id: string;
  },
): Promise<FocusDismissalRow> {
  const data = await run(
    from(client, "focus_dismissals")
      .insert({
        ...input,
        reason: input.reason ?? null,
        snooze_until: input.snooze_until ?? null,
      })
      .select("id, item_key, action, reason, snooze_until, actor_user_id, created_at"),
    "insertFocusDismissal",
  );
  const rows = parseInternal(z.array(focusDismissalRowSchema), data ?? [], "insertFocusDismissal");
  const row = rows[0];
  if (row === undefined) throw new Error("insertFocusDismissal: insert returned no row");
  return row;
}
