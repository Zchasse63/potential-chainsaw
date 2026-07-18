import type { Queryable } from "../../processors.js";

/**
 * SQL owns segment windows, evidence, rule versions, run snapshots, and
 * priority hygiene. The worker is intentionally only the tenant-scoped
 * deterministic batch trigger.
 */
export async function recomputeSegments(pool: Queryable, tenantId: string): Promise<void> {
  const result = await pool.query("select app.recompute_segments($1::uuid) as run_id", [tenantId]);
  const row = result.rows[0] as { run_id?: unknown } | undefined;
  if (typeof row?.run_id !== "string") {
    throw new Error(`segment recompute failed for tenant ${tenantId}`);
  }
}
