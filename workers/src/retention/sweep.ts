import { z } from "zod";
import type { Queryable } from "../processors.js";

export const RETENTION_SWEEP_KIND = "retention.sweep";

const policySchema = z.object({
  data_class: z.enum([
    "comms_content",
    "ai_artifacts",
    "raw_payloads",
    "import_quarantine",
    "webhook_events",
    "reconciliations",
  ]),
  retention_days: z.number().int().nonnegative(),
  action: z.enum(["delete", "scrub_body", "pseudonymize"]),
  version: z.number().int().positive(),
  tenant_id: z.string().uuid().nullable(),
});

export type RetentionPolicy = z.infer<typeof policySchema>;
export interface RetentionSweepSummary {
  tenant_id: string;
  expired_exports: number;
  touched: Record<RetentionPolicy["data_class"], number>;
}

async function effectivePolicies(
  pool: Queryable,
  tenantId: string,
): Promise<RetentionPolicy[]> {
  const result = await pool.query(
    `select distinct on (rp.data_class)
       rp.data_class, rp.retention_days, rp.action, rp.version, rp.tenant_id
     from public.retention_policies rp
     where (rp.data_class = 'webhook_events' and rp.tenant_id is null)
        or (rp.data_class <> 'webhook_events'
            and (rp.tenant_id is null or rp.tenant_id = $1::uuid))
     order by rp.data_class, (rp.tenant_id is not null) desc, rp.version desc`,
    [tenantId],
  );
  return z.array(policySchema).parse(result.rows);
}

async function applyPolicy(
  pool: Queryable,
  tenantId: string,
  policy: RetentionPolicy,
): Promise<number> {
  const result = await pool.query(
    `select app.apply_retention_policy($1::uuid, $2::text, $3::int, $4::text) as touched`,
    [tenantId, policy.data_class, policy.retention_days, policy.action],
  );
  const parsed = z.object({ touched: z.number().int().nonnegative() }).safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new Error(`retention action did not return a row count: ${parsed.error.message}`);
  }
  return parsed.data.touched;
}

/**
 * Applies the effective tenant matrix. Every mutation is age-bounded; body
 * scrubbing excludes already-scrubbed rows, and deletes are naturally
 * idempotent. No SQL in this module names an append-only ledger/evidence table.
 *
 * The service-only definer owns the exact mutation allowlist, so the worker DB
 * role never gains raw table DELETE. webhook_events predates tenancy and has
 * no tenant_id: only its global policy may govern it.
 */
export async function runRetentionSweep(
  pool: Queryable,
  tenantId: string,
): Promise<RetentionSweepSummary> {
  const policies = await effectivePolicies(pool, tenantId);
  const expiredResult = await pool.query(
    "select app.expire_data_exports($1::uuid) as touched",
    [tenantId],
  );
  const expiredExports = z
    .object({ touched: z.number().int().nonnegative() })
    .parse(expiredResult.rows[0]).touched;
  const touched: RetentionSweepSummary["touched"] = {
    comms_content: 0,
    ai_artifacts: 0,
    raw_payloads: 0,
    import_quarantine: 0,
    webhook_events: 0,
    reconciliations: 0,
  };

  for (const policy of policies) {
    if (policy.data_class === "webhook_events" && policy.tenant_id !== null) continue;
    touched[policy.data_class] = await applyPolicy(pool, tenantId, policy);
  }

  const summary = { tenant_id: tenantId, expired_exports: expiredExports, touched };
  console.info(JSON.stringify({ event: "retention_run", ...summary }));
  return summary;
}
