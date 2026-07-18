/**
 * @kelo/workers — processors for the Postgres jobs queue (migration 0005).
 * Exactly one scheduler (CLAUDE.md invariant #4): the Netlify tick calls
 * runTick(), which is the ONLY claim path onto the queue — never pg_cron,
 * never a second cron.
 */
import { createGlofoxProcessors } from "./glofox/processors.js";

/**
 * Minimal structural subset of pg.Pool used by the tick. Keeping this an
 * interface (instead of importing pg) keeps @kelo/workers dependency-light and
 * lets unit tests inject a fake query function — a pg Pool satisfies it.
 */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/** Row shape of public.jobs (supabase/migrations/20260717120500_0005_jobs_queue.sql). */
export interface JobRow {
  id: string;
  tenant_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  priority: number;
  run_after: string;
  status: "queued" | "running" | "succeeded" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  locked_by: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Context handed to every processor for one tick cycle. */
export interface TickCtx {
  pool: Queryable;
  workerId: string;
  heartbeatUrl?: string;
}

export type JobProcessor = (job: JobRow, ctx: TickCtx) => Promise<void>;

/**
 * Processor registry, keyed by jobs.kind. Real processors (Glofox import, AI
 * briefing generation) land in later units and register here. A claimed job
 * whose kind is NOT in this registry is failed loudly by the tick — unknown
 * kinds never silently succeed.
 */
export const processors: Record<string, JobProcessor> = {
  /** No-op: queue plumbing smoke tests. */
  noop: async () => {},

  /** Liveness ping job: hits the external dead-man URL if one is configured. */
  heartbeat: async (_job, ctx) => {
    if (ctx.heartbeatUrl) {
      await fetch(ctx.heartbeatUrl);
    }
  },

  /**
   * Glofox sync (phase 1 · unit 4): the six entity jobs + the hourly fan-out.
   * Built from env config at module load (glofoxConfigFromEnv reads NAMES
   * only); each run still re-reads nothing — credentials rotate by redeploy.
   */
  ...createGlofoxProcessors(),
};
