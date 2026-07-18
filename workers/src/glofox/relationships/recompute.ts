import type { Queryable } from "../../processors.js";

/**
 * SQL owns relationship evidence, precedence, effective periods, and logging.
 * The worker is intentionally only the tenant-scoped batch trigger.
 */
export async function recomputeAllRelationships(
  pool: Queryable,
  tenantId: string,
): Promise<void> {
  await pool.query("select app.recompute_all_relationships($1::uuid) as processed_count", [tenantId]);
}
