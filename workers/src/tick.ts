import { processors, type JobRow, type Queryable, type TickCtx } from "./processors.js";

export interface TickOptions {
  workerId: string;
  batch?: number;
  heartbeatUrl?: string;
}

export interface TickResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * The SINGLE scheduler tick body (CLAUDE.md invariant #4). Invoked by the one
 * Netlify Scheduled Function (wired up next unit) on its 5-minute cadence; this
 * function is the ONLY claim path onto the jobs queue. Double-fire is safe:
 * app.claim_jobs() uses FOR UPDATE SKIP LOCKED, so two concurrent ticks can
 * never claim the same job — and every job completes/fails in its own query.
 */
export async function runTick(pool: Queryable, opts: TickOptions): Promise<TickResult> {
  const batch = opts.batch ?? 10;

  // 1) Crash recovery first: requeue/dead-letter jobs whose lease expired.
  await pool.query("select app.reap_expired_leases()");

  // 2) Claim a batch atomically (FOR UPDATE SKIP LOCKED inside the function).
  const claimedResult = await pool.query("select * from app.claim_jobs($1, $2)", [
    opts.workerId,
    batch,
  ]);
  const claimed = claimedResult.rows as JobRow[];

  const ctx: TickCtx = { pool, workerId: opts.workerId, heartbeatUrl: opts.heartbeatUrl };

  let succeeded = 0;
  let failed = 0;

  // 3) Dispatch each job to its processor; finalize it individually.
  for (const job of claimed) {
    const processor = processors[job.kind];
    if (processor === undefined) {
      // Fail loudly, never silently succeed (invariant #8's quarantine rule
      // applied to the queue): an unknown kind is a defect, not a no-op.
      await pool.query("select app.fail_job($1, $2, $3)", [
        job.id,
        opts.workerId,
        `unknown job kind: ${job.kind}`,
      ]);
      failed += 1;
      continue;
    }
    try {
      await processor(job, ctx);
      await pool.query("select app.complete_job($1, $2)", [job.id, opts.workerId]);
      succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query("select app.fail_job($1, $2, $3)", [job.id, opts.workerId, message]);
      failed += 1;
    }
  }

  // 4) External dead-man's switch: ping AFTER the cycle, so the absence of a
  // ping means the tick (or the platform) is dead. A heartbeat outage must
  // never break the tick itself → network errors are swallowed on purpose.
  if (opts.heartbeatUrl) {
    try {
      await fetch(opts.heartbeatUrl);
    } catch {
      // Deliberately ignored: the missed ping IS the alert.
    }
  }

  return { claimed: claimed.length, succeeded, failed };
}
