import { z } from "zod";
import type { JobProcessor, JobRow, Queryable } from "../processors.js";

/**
 * Phase 6 · unit 6.2 — the two booking-engine sweeps that ride the scheduler
 * (CLAUDE.md invariant #4: exactly one scheduler; these register on the existing
 * fan-out, never a second cron).
 *
 *   booking.waitlist_sweep — FREQUENT (minute-scoped, like expire_holds). GLOBAL
 *     (tenant NULL): app.decline_or_expire_offers scans every tenant's lapsed
 *     offers, releases the offer hold, and cascade-promotes the next waiter.
 *
 *   booking.no_show_sweep — DAILY (per tenant). app.mark_no_shows flips a booked
 *     attendee of a session ended > 30min ago to 'no_show' and records the
 *     forfeit (no credit refund — the debit already stands; owner default).
 *
 * NO wall-clock in this library code: `now()` is evaluated inside Postgres at the
 * RPC boundary, so the sweeps carry no injected clock and stay deterministic to
 * the DB. The tick owns the pool; these processors never open one.
 */

export const WAITLIST_SWEEP_KIND = "booking.waitlist_sweep";
export const NO_SHOW_SWEEP_KIND = "booking.no_show_sweep";

const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * GLOBAL waitlist sweep: settle every lapsed/declined offer and promote the next
 * waiter. tenant-independent (the RPC scans all tenants), so the job row carries
 * no tenant_id.
 */
export const runWaitlistSweep: JobProcessor = async (_job: JobRow, ctx): Promise<void> => {
  const result = await ctx.pool.query(
    "select app.decline_or_expire_offers(now()) as n",
    [],
  );
  const { n } = countRow.parse(result.rows[0]);
  console.info(JSON.stringify({ event: "waitlist_sweep", settled: n }));
};

/** Per-tenant no-show sweep: mark expired booked attendees as no-shows. */
export const runNoShowSweep: JobProcessor = async (job: JobRow, ctx): Promise<void> => {
  if (job.tenant_id === null) {
    throw new Error(`${NO_SHOW_SWEEP_KIND} requires a tenant-scoped job row (tenant_id is null)`);
  }
  const result = await ctx.pool.query(
    "select app.mark_no_shows($1::uuid, now()) as n",
    [job.tenant_id],
  );
  const { n } = countRow.parse(result.rows[0]);
  console.info(JSON.stringify({ event: "no_show_sweep", tenant_id: job.tenant_id, marked: n }));
};

/** Registry fragment merged into the processor table in ../processors.ts. */
export function createBookingProcessors(): Record<string, JobProcessor> {
  return {
    [WAITLIST_SWEEP_KIND]: runWaitlistSweep,
    [NO_SHOW_SWEEP_KIND]: runNoShowSweep,
  };
}

/** Exported for the query-signature guard test. */
export type BookingSweep = (pool: Queryable) => Promise<void>;
