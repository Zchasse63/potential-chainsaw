import { createGlofoxClient, glofoxConfigFromEnv, type GlofoxClient } from "@kelo/glofox";
import type { GlofoxConfig } from "@kelo/glofox";
import type { JobProcessor, JobRow, TickCtx } from "../processors.js";
import { runEntitySync } from "./pipeline.js";
import type { EntitySpec, SyncGlofoxClient } from "./types.js";
import { bookingsSpec } from "./entities/bookings.js";
import { createCreditsSpec } from "./entities/credits.js";
import { eventsSpec } from "./entities/events.js";
import { membersSpec } from "./entities/members.js";
import { membershipsSpec } from "./entities/memberships.js";
import { transactionsSpec } from "./entities/transactions.js";
import { runReconciliation } from "./reconcile/reconcile.js";
import { runDeletionDetection } from "./deletion/deletion.js";

/**
 * Phase 1 · unit 4 — the Glofox sync job processors. Each 'glofox.sync.*'
 * processor resolves its tenant from the JOB ROW (tenant_id is mandatory for
 * these kinds — fail loudly when missing), builds the shared client from env
 * config (glofoxConfigFromEnv — names only, never logged), and runs the
 * pipeline. The tick owns the pool: processors receive ctx.pool, they never
 * create one.
 *
 * SCHEDULING (documented hookup): 'glofox.sync.all' fans out the six entity
 * jobs with idempotency keys scoped to the hour, so hourly re-fires dedupe.
 * The actual cron cadence (hourly baseline; 15-minute roster during operating
 * hours — plan-final §4) is wired when the scheduler tick gains a real
 * schedule table: unit 1.5/1.7 work. Until then the seven kinds exist and are
 * enqueueable by hand/tests.
 */

export const GLOFOX_SYNC_KINDS = [
  "glofox.sync.members",
  "glofox.sync.memberships",
  "glofox.sync.events",
  "glofox.sync.bookings",
  "glofox.sync.transactions",
  "glofox.sync.credits",
] as const;

export const GLOFOX_SYNC_ALL_KIND = "glofox.sync.all";

/** Phase 1 · unit 5 — the trust engine + deletion detection (plan-final §4). */
export const GLOFOX_RECONCILE_KIND = "glofox.reconcile";
export const GLOFOX_DETECT_DELETIONS_KIND = "glofox.detect_deletions";

/** Test seam: inject a fake client/config/clock; production uses env. */
export interface GlofoxProcessorDeps {
  readonly client?: GlofoxClient;
  readonly config?: GlofoxConfig;
  readonly now?: () => Date;
}

function requireTenant(job: JobRow): string {
  if (job.tenant_id === null) {
    throw new Error(`${job.kind} requires a tenant-scoped job row (tenant_id is null)`);
  }
  return job.tenant_id;
}

/** Row-type erasure at the registry boundary; the pipeline is generic over TRow. */
function erase<TRow>(spec: EntitySpec<TRow>): EntitySpec<unknown> {
  return spec as unknown as EntitySpec<unknown>;
}

export function createGlofoxProcessors(
  deps: GlofoxProcessorDeps = {},
): Record<string, JobProcessor> {
  const now = deps.now ?? (() => new Date());
  // Config + client are resolved PER RUN (never at module load): env is read
  // inside the processor so importing the registry never throws, and a
  // credential rotation is picked up by the next run.
  const resolve = (): { config: GlofoxConfig; client: SyncGlofoxClient } => {
    const config = deps.config ?? glofoxConfigFromEnv();
    if (deps.client !== undefined) return { config, client: deps.client };
    const real = createGlofoxClient(config);
    return { config, client: { fetch: real.fetch, branchGet: () => real.branch.get() } };
  };

  const syncProcessor =
    (spec: () => EntitySpec<unknown>): JobProcessor =>
    async (job, ctx: TickCtx) => {
      const tenantId = requireTenant(job);
      const { config, client } = resolve();
      await runEntitySync(
        ctx.pool,
        client,
        {
          tenantId,
          jobId: job.id,
          branchId: config.branchId,
          namespace: config.namespace,
          now,
          payload: job.payload,
        },
        spec(),
      );
    };

  return {
    [GLOFOX_SYNC_KINDS[0]]: syncProcessor(() => erase(membersSpec)),
    [GLOFOX_SYNC_KINDS[1]]: syncProcessor(() => erase(membershipsSpec)),
    [GLOFOX_SYNC_KINDS[2]]: syncProcessor(() => erase(eventsSpec)),
    [GLOFOX_SYNC_KINDS[3]]: syncProcessor(() => erase(bookingsSpec)),
    [GLOFOX_SYNC_KINDS[4]]: syncProcessor(() => erase(transactionsSpec)),
    [GLOFOX_SYNC_KINDS[5]]: syncProcessor(() => erase(createCreditsSpec())),

    /**
     * Phase 1 · unit 5 — the trust engine (tripwire 5) + deletion detection.
     * Same tenant/job-row + per-run client resolution as the sync processors.
     */
    [GLOFOX_RECONCILE_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      const { config, client } = resolve();
      await runReconciliation(ctx.pool, client, {
        tenantId,
        jobId: job.id,
        branchId: config.branchId,
        namespace: config.namespace,
        now,
        payload: job.payload,
      });
    },

    [GLOFOX_DETECT_DELETIONS_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      const { config, client } = resolve();
      await runDeletionDetection(ctx.pool, client, {
        tenantId,
        jobId: job.id,
        branchId: config.branchId,
        namespace: config.namespace,
        now,
        payload: job.payload,
      });
    },

    /** Fan-out: enqueue the entity jobs + the trust-engine jobs, idempotency
     * keys scoped to the hour. Unit 1.5: reconcile + detect_deletions trail
     * the entity syncs here; their DAILY cadence (plan-final §4: daily
     * reconciliation) is wired when the scheduler gains a real schedule table
     * in unit 1.7 — until then the hour-scoped dedupe applies to them too. */
    [GLOFOX_SYNC_ALL_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      const hourBucket = now().toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const kinds = [...GLOFOX_SYNC_KINDS, GLOFOX_RECONCILE_KIND, GLOFOX_DETECT_DELETIONS_KIND];
      for (const kind of kinds) {
        await ctx.pool.query(`select app.enqueue_job($1, $2, $3, now(), 100, 5, $4)`, [
          kind,
          JSON.stringify({}),
          tenantId,
          `${kind}:${tenantId}:${hourBucket}`,
        ]);
      }
    },
  };
}
