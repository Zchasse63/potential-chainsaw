import type { Queryable } from "../processors.js";

/** The jobs.kind for the hold-expiry sweep processor (migration 0040). */
export const BOOKING_EXPIRE_HOLDS_KIND = "booking.expire_holds";

export interface ExpireHoldsDeps {
  /** Injected clock (no wall-clock in library code); the tick passes its shared now. */
  now?: () => Date;
}

/**
 * Phase 6 · unit 6.1 — the hold-expiry sweep. GLOBAL (no tenant on the job):
 * one pass reclaims every expired, UN-frozen seat hold across tenants. The
 * frozen-guard lives IN the SQL function (app.expire_holds deletes only
 * `where expires_at < p_now and not frozen`), so this processor never issues an
 * ad-hoc DELETE — it DELEGATES to the guarded definer function, which is why a
 * frozen (mid-tender) hold is never reclaimed. p_now is injected so the boundary
 * stays a pure function of the caller's clock. Returns the deleted count.
 */
export async function runExpireHolds(pool: Queryable, deps: ExpireHoldsDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const result = await pool.query("select app.expire_holds($1) as deleted", [now().toISOString()]);
  const row = result.rows[0] as { deleted?: number | string | null } | undefined;
  const deleted = row?.deleted;
  return typeof deleted === "number" ? deleted : Number(deleted ?? 0);
}
