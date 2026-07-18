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
import { recomputeAllRelationships } from "./relationships/recompute.js";
import { recomputeSegments } from "./segments/derive.js";
import { runBriefing } from "../briefing/generate.js";
import type { FetchImpl } from "../briefing/synthesize.js";
import { COMMS_SEND_KIND, createCommsSendProcessor } from "../comms/send.js";
import type { Env, FetchImpl as CommsFetchImpl, MessageAdapter } from "@kelo/comms";
import {
  CAMPAIGNS_LIFECYCLE_KIND,
  createLifecycleProcessor,
} from "../campaigns/lifecycle.js";
import {
  CAMPAIGNS_ATTRIBUTE_KIND,
  createAttributionProcessor,
} from "../campaigns/attribution.js";

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

/** Phase 1 · unit 8 — SQL-owned relationship derivation. */
export const DERIVE_RELATIONSHIPS_KIND = "derive.relationships";

/** Phase 2 · unit 2 — SQL-owned deterministic behavioral segments. */
export const DERIVE_SEGMENTS_KIND = "derive.segments";

/** Phase 2 · unit 3 — deterministic facts followed by optional AI narration. */
export const DERIVE_BRIEFING_KIND = "derive.briefing";

/** Logical sync-all order. The last four are enqueued in one ordered SQL
 * statement so relationship precedence is explicit without adding round trips. */
export const GLOFOX_SYNC_ALL_KINDS = [
  ...GLOFOX_SYNC_KINDS,
  GLOFOX_RECONCILE_KIND,
  GLOFOX_DETECT_DELETIONS_KIND,
  DERIVE_RELATIONSHIPS_KIND,
  DERIVE_SEGMENTS_KIND,
  CAMPAIGNS_LIFECYCLE_KIND,
  CAMPAIGNS_ATTRIBUTE_KIND,
  DERIVE_BRIEFING_KIND,
] as const;

/** Test seam: inject a fake client/config/clock; production uses env. */
export interface GlofoxProcessorDeps {
  readonly client?: GlofoxClient;
  readonly config?: GlofoxConfig;
  readonly now?: () => Date;
  readonly briefingFetchImpl?: FetchImpl;
  readonly briefingEnv?: NodeJS.ProcessEnv;
  readonly commsEnv?: Env;
  readonly commsFetchImpl?: CommsFetchImpl;
  readonly commsEmailAdapter?: MessageAdapter;
  readonly commsSmsAdapter?: MessageAdapter;
  readonly campaignDraftFetchImpl?: typeof fetch;
  readonly campaignDraftEnv?: NodeJS.ProcessEnv;
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
    [COMMS_SEND_KIND]: createCommsSendProcessor({
      env: deps.commsEnv,
      fetchImpl: deps.commsFetchImpl,
      emailAdapter: deps.commsEmailAdapter,
      smsAdapter: deps.commsSmsAdapter,
      now,
    }),
    [CAMPAIGNS_LIFECYCLE_KIND]: createLifecycleProcessor({
      now,
      draft: { fetchImpl: deps.campaignDraftFetchImpl, env: deps.campaignDraftEnv },
    }),
    [CAMPAIGNS_ATTRIBUTE_KIND]: createAttributionProcessor(),
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

    /** No Glofox client/config is needed: the deterministic SQL function owns
     * all evidence reads, effective dating, precedence, and transition logs. */
    [DERIVE_RELATIONSHIPS_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      await recomputeAllRelationships(ctx.pool, tenantId);
    },

    /** Segment predicates consume people.primary_relationship, so this kind
     * must remain after derive.relationships in the sync-all fan-out. */
    [DERIVE_SEGMENTS_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      await recomputeSegments(ctx.pool, tenantId);
      // Lifecycle proposals are enqueued only after segment recomputation has
      // actually completed (not merely after its job was inserted). The day
      // key keeps the hourly sync fan-out to one lifecycle evaluation daily.
      const dayBucket = now().toISOString().slice(0, 10);
      await ctx.pool.query(`select app.enqueue_job($1, $2, $3, now(), 100, 5, $4)`, [
        CAMPAIGNS_LIFECYCLE_KIND,
        JSON.stringify({}),
        tenantId,
        `${CAMPAIGNS_LIFECYCLE_KIND}:${tenantId}:${dayBucket}`,
      ]);
    },

    /** Briefing facts consume the latest segment snapshots, so this processor
     * remains after derive.segments in the ordered sync-all fan-out. */
    [DERIVE_BRIEFING_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      await runBriefing(ctx.pool, tenantId, {
        fetchImpl: deps.briefingFetchImpl,
        env: deps.briefingEnv,
      });
    },

    /** Fan-out: enqueue the entity jobs + the trust-engine jobs, idempotency
     * keys scoped to the hour. Unit 1.5: reconcile + detect_deletions trail
     * the entity syncs here; their DAILY cadence (plan-final §4: daily
     * reconciliation) is wired when the scheduler gains a real schedule table
     * in unit 1.7 — until then the hour-scoped dedupe applies to them too. */
    [GLOFOX_SYNC_ALL_KIND]: async (job, ctx) => {
      const tenantId = requireTenant(job);
      const instant = now();
      const hourBucket = instant.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const dayBucket = instant.toISOString().slice(0, 10); // YYYY-MM-DD
      const independentlyEnqueuedKinds = [...GLOFOX_SYNC_KINDS, GLOFOX_RECONCILE_KIND] as const;
      for (const kind of independentlyEnqueuedKinds) {
        await ctx.pool.query(`select app.enqueue_job($1, $2, $3, now(), 100, 5, $4)`, [
          kind,
          JSON.stringify({}),
          tenantId,
          `${kind}:${tenantId}:${hourBucket}`,
        ]);
      }

      // One ordered statement preserves the established eight-query fan-out.
      // Segment execution itself later enqueues the day-deduped lifecycle
      // proposal, so proposal creation cannot race segment recomputation.
      await ctx.pool.query(
        `with deletion_job as (
           select app.enqueue_job($1, $2, $3, now(), 100, 5, $4) as id
         ), relationship_job as (
           select app.enqueue_job($5, $6, $7, now(), 100, 5, $8) as id
           from deletion_job
         ), segment_job as (
           select app.enqueue_job($9, $10, $11, now(), 100, 5, $12) as id
           from relationship_job
         ), attribution_job as (
           select app.enqueue_job($13, $14, $15, now(), 100, 5, $16) as id
           from segment_job
         ), briefing_job as (
           select app.enqueue_job($17, $18, $19, now(), 100, 5, $20) as id
           from attribution_job
         )
         select id from briefing_job`,
        [
          GLOFOX_DETECT_DELETIONS_KIND,
          JSON.stringify({}),
          tenantId,
          `${GLOFOX_DETECT_DELETIONS_KIND}:${tenantId}:${hourBucket}`,
          DERIVE_RELATIONSHIPS_KIND,
          JSON.stringify({}),
          tenantId,
          `${DERIVE_RELATIONSHIPS_KIND}:${tenantId}:${hourBucket}`,
          DERIVE_SEGMENTS_KIND,
          JSON.stringify({}),
          tenantId,
          `${DERIVE_SEGMENTS_KIND}:${tenantId}:${hourBucket}`,
          CAMPAIGNS_ATTRIBUTE_KIND,
          JSON.stringify({}),
          tenantId,
          `${CAMPAIGNS_ATTRIBUTE_KIND}:${tenantId}:${dayBucket}`,
          DERIVE_BRIEFING_KIND,
          JSON.stringify({}),
          tenantId,
          `${DERIVE_BRIEFING_KIND}:${tenantId}:${hourBucket}`,
        ],
      );
    },
  };
}
