import { createHash } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../processors.js";
import { buildCandidates } from "./candidates.js";
import { selectCandidates } from "./select.js";
import {
  BRIEFING_PROMPT_VERSION,
  DEFAULT_ANTHROPIC_MODEL,
  synthesizeBriefing,
  type FetchImpl,
} from "./synthesize.js";
import {
  deterministicOutput,
  metricDefinitionInputSchema,
  type MetricDefinitionInput,
} from "./types.js";

const businessDateSchema = z.object({ business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const healthSchema = z.object({
  red: z.boolean(),
  drift_rows: z.number().int().nonnegative(),
  drift_count: z.number().int().nonnegative(),
  reconciliation_ids: z.array(z.string().uuid()),
  sync_entities: z.array(z.string()),
});

const artifactSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  kind: z.literal("briefing"),
  // node-pg returns `date` columns as JS Date objects over a live wire (the
  // test fakes return strings) — accept both, normalize to YYYY-MM-DD.
  generated_for: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.date()])
    .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
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
export type BriefingArtifact = z.infer<typeof artifactSchema>;

export interface RunBriefingOptions {
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
  reconciliationDriftThreshold?: number;
}

const ARTIFACT_COLUMNS = `id, tenant_id, kind, generated_for, status, prompt_version,
  model, input, input_hash, output, cost_usd::float8 as cost_usd, created_at::text as created_at,
  error`;

function artifactFromRows(rows: unknown[], label: string): BriefingArtifact | null {
  const first = rows[0];
  if (first === undefined) return null;
  const parsed = artifactSchema.safeParse(first);
  if (!parsed.success) {
    throw new Error(`${label} returned an invalid artifact: ${parsed.error.message}`);
  }
  return parsed.data;
}

function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function fetchBusinessDate(pool: Queryable, tenantId: string): Promise<string> {
  const result = await pool.query(
    `select (now() at time zone l.timezone)::date::text as business_date
     from public.locations l
     where l.tenant_id = $1::uuid
     order by l.created_at, l.id
     limit 1`,
    [tenantId],
  );
  const parsed = businessDateSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new Error(`cannot generate a briefing without a studio-local business date: ${parsed.error.message}`);
  }
  return parsed.data.business_date;
}

async function findArtifact(
  pool: Queryable,
  tenantId: string,
  businessDate: string,
): Promise<BriefingArtifact | null> {
  const result = await pool.query(
    `select ${ARTIFACT_COLUMNS}
     from public.ai_artifacts
     where tenant_id = $1::uuid and kind = 'briefing' and generated_for = $2::date
     limit 1`,
    [tenantId, businessDate],
  );
  return artifactFromRows(result.rows, "briefing idempotency lookup");
}

async function fetchHealth(
  pool: Queryable,
  tenantId: string,
  driftThreshold: number,
): Promise<z.infer<typeof healthSchema>> {
  const result = await pool.query(
    `with latest_per_entity as (
       -- Health = the CURRENT reconciliation state: the LATEST row per entity,
       -- not 24h of history (stale rows from a superseded engine run must not
       -- pin the briefing red — live finding, first production generation).
       select distinct on (r.entity) r.id, r.entity, r.status,
         abs(coalesce(r.drift_count, 0)) as drift_count
       from public.reconciliations r
       where r.tenant_id = $1::uuid
         and r.checked_at >= now() - interval '48 hours'
       order by r.entity, r.checked_at desc
     ), red_drifts as (
       select l.id, l.drift_count
       from latest_per_entity l
       where l.status = 'drift'
         and l.drift_count > $2::int
     ), bad_sync as (
       select ss.entity
       from public.sync_state ss
       where ss.tenant_id = $1::uuid
         and ss.health_state in ('error', 'paused_auth_failed')
     )
     select
       (exists (select 1 from red_drifts) or exists (select 1 from bad_sync)) as red,
       (select count(*)::int from red_drifts) as drift_rows,
       (select coalesce(sum(drift_count), 0)::int from red_drifts) as drift_count,
       coalesce((select array_agg(id order by id) from red_drifts), '{}'::uuid[]) as reconciliation_ids,
       coalesce((select array_agg(entity order by entity) from bad_sync), '{}'::text[]) as sync_entities`,
    [tenantId, Math.max(0, Math.trunc(driftThreshold))],
  );
  const parsed = healthSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new Error(`briefing health query returned an invalid shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function fetchDefinitions(
  pool: Queryable,
  keys: readonly string[],
): Promise<MetricDefinitionInput[]> {
  if (keys.length === 0) return [];
  const result = await pool.query(
    `select distinct on (md.key) md.key, md.version, md.definition
     from public.metric_definitions md
     where md.key = any($1::text[])
     order by md.key, md.version desc`,
    [keys],
  );
  const parsed = z.array(metricDefinitionInputSchema).safeParse(result.rows);
  if (!parsed.success) {
    throw new Error(`briefing metric-definition query returned an invalid shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function insertArtifact(
  pool: Queryable,
  artifact: {
    tenantId: string;
    generatedFor: string;
    status: "generated" | "fallback" | "refused";
    model: string | null;
    input: unknown;
    output: unknown;
    costUsd: number | null;
    error: string | null;
  },
): Promise<BriefingArtifact> {
  const inputHash = hashInput(artifact.input);
  const result = await pool.query(
    `insert into public.ai_artifacts
       (tenant_id, kind, generated_for, status, prompt_version, model, input,
        input_hash, output, cost_usd, error)
     values ($1::uuid, 'briefing', $2::date, $3, $4, $5, $6::jsonb, $7,
             $8::jsonb, $9, $10)
     on conflict (tenant_id, kind, generated_for) do nothing
     returning ${ARTIFACT_COLUMNS}`,
    [
      artifact.tenantId,
      artifact.generatedFor,
      artifact.status,
      BRIEFING_PROMPT_VERSION,
      artifact.model,
      JSON.stringify(artifact.input),
      inputHash,
      JSON.stringify(artifact.output),
      artifact.costUsd,
      artifact.error,
    ],
  );
  const inserted = artifactFromRows(result.rows, "briefing insert");
  if (inserted !== null) return inserted;
  const raced = await findArtifact(pool, artifact.tenantId, artifact.generatedFor);
  if (raced === null) throw new Error("briefing insert conflicted but no artifact exists");
  return raced;
}

export async function runBriefing(
  pool: Queryable,
  tenantId: string,
  options: RunBriefingOptions = {},
): Promise<BriefingArtifact> {
  const env = options.env ?? process.env;
  const businessDate = await fetchBusinessDate(pool, tenantId);
  const existing = await findArtifact(pool, tenantId, businessDate);
  if (existing !== null) return existing;

  // This refusal fence deliberately runs before candidate generation and any
  // possible provider call. Red source data is never narrated by the model.
  const health = await fetchHealth(
    pool,
    tenantId,
    options.reconciliationDriftThreshold ?? 0,
  );
  if (health.red) {
    const reasons = [
      ...(health.drift_rows > 0 ? ["reconciliation drift exceeds threshold"] : []),
      ...(health.sync_entities.length > 0 ? ["sync health is red"] : []),
    ];
    const input = { business_date: businessDate, health };
    return insertArtifact(pool, {
      tenantId,
      generatedFor: businessDate,
      status: "refused",
      model: null,
      input,
      output: {
        insights: [],
        message: "briefing refused because source data health is red",
        health,
      },
      costUsd: null,
      error: reasons.join("; "),
    });
  }

  const candidates = await buildCandidates(pool, tenantId);
  const selected = selectCandidates(candidates);
  const metricKeys = [
    ...new Set(
      selected.flatMap((candidate) => {
        const refs = candidate.evidence["metric_refs"];
        return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
      }),
    ),
  ].sort();
  const metricDefinitions = await fetchDefinitions(pool, metricKeys);
  const input = {
    business_date: businessDate,
    candidates,
    selected,
    metric_definitions: metricDefinitions,
  };

  if (selected.length === 0) {
    return insertArtifact(pool, {
      tenantId,
      generatedFor: businessDate,
      status: "fallback",
      model: null,
      input,
      output: deterministicOutput([]),
      costUsd: null,
      error: null,
    });
  }

  if ((env.ANTHROPIC_API_KEY?.trim() ?? "") === "") {
    return insertArtifact(pool, {
      tenantId,
      generatedFor: businessDate,
      status: "fallback",
      model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
      input,
      output: deterministicOutput(selected),
      costUsd: null,
      error: "ANTHROPIC_API_KEY is not configured",
    });
  }

  const synthesis = await synthesizeBriefing(selected, metricDefinitions, {
    fetchImpl: options.fetchImpl,
    env,
  });
  return insertArtifact(pool, {
    tenantId,
    generatedFor: businessDate,
    status: synthesis.status,
    model: synthesis.model,
    input,
    output: synthesis.output,
    costUsd: synthesis.costUsd,
    error: synthesis.status === "fallback" ? synthesis.error : null,
  });
}
