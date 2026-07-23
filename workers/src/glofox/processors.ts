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
import { CAMPAIGNS_LIFECYCLE_KIND, createLifecycleProcessor } from "../campaigns/lifecycle.js";
import { CAMPAIGNS_ATTRIBUTE_KIND, createAttributionProcessor } from "../campaigns/attribution.js";
import { RETENTION_SWEEP_KIND, runRetentionSweep } from "../retention/sweep.js";
import { PERSON_DELETE_KIND, processPersonDelete } from "../people/delete.js";
import { PERSON_EXPORT_KIND, processPersonExport } from "../people/export.js";
import { BILLING_PROCESS_INBOX_KIND, runInbox } from "../billing/inbox.js";
import { BILLING_PROCESS_OUTBOX_KIND, runOutbox, type StripeAdapter } from "../billing/outbox.js";
import { BILLING_VERIFY_MONEY_KIND, runVerifyMoney } from "../billing/verify.js";
import { BILLING_DUNNING_KIND, runDunning } from "../billing/dunning.js";
import { BOOKING_EXPIRE_HOLDS_KIND, runExpireHolds } from "../booking/expire-holds.js";
import { NO_SHOW_SWEEP_KIND, WAITLIST_SWEEP_KIND } from "../booking/sweeps.js";
import type { Env as StripeEnv } from "@kelo/stripe";

export {
  RETENTION_SWEEP_KIND,
  PERSON_DELETE_KIND,
  PERSON_EXPORT_KIND,
  BILLING_PROCESS_INBOX_KIND,
  BILLING_PROCESS_OUTBOX_KIND,
  BILLING_VERIFY_MONEY_KIND,
  BILLING_DUNNING_KIND,
  BOOKING_EXPIRE_HOLDS_KIND,
};

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
  RETENTION_SWEEP_KIND,
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
  /** Billing outbox: env the default StripeClient reads STRIPE_SECRET_KEY from. */
  readonly stripeEnv?: StripeEnv;
  /** Billing outbox: inject a Stripe adapter double (MockStripe) in tests. */
  readonly stripeMakeClient?: (opts: { stripeAccountId: string }) => StripeAdapter;
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
    [RETENTION_SWEEP_KIND]: async (job, ctx) => {
      await runRetentionSweep(ctx.pool, requireTenant(job));
    },
    [PERSON_DELETE_KIND]: processPersonDelete,
    [PERSON_EXPORT_KIND]: processPersonExport,

    /**
     * Phase 5 · unit 5.3 — the billing spine drains. GLOBAL (no tenant on the
     * job): stripe_events has no tenant_id, and the outbox scopes every mutation
     * by the command row's own tenant_id. The webhook receiver is the AUTHORITY;
     * these processors are the confirmation (inbox) + delivery (outbox) engines.
     */
    [BILLING_PROCESS_INBOX_KIND]: async (_job, ctx) => {
      await runInbox(ctx.pool, { now });
    },
    [BILLING_PROCESS_OUTBOX_KIND]: async (_job, ctx) => {
      await runOutbox(ctx.pool, { env: deps.stripeEnv, makeClient: deps.stripeMakeClient });
    },

    /**
     * Phase 5 · unit 5.5 — the NIGHTLY money-verification sweep (the phase-5
     * gate proof). GLOBAL like the drains: one run scans every tenant's billing
     * ledgers, records a verify_runs row, and opens deduped per-tenant alerts.
     * READ-ONLY over payments/stripe_commands/stripe_events.
     */
    [BILLING_VERIFY_MONEY_KIND]: async (_job, ctx) => {
      await runVerifyMoney(ctx.pool, { now });
    },

    /**
     * Phase 5 · unit 5.6 — the DUNNING state machine's time-driven clock. GLOBAL
     * (no tenant on the job): it scans every open dunning cycle across tenants
     * and advances reminders / final-notice / past_due on the studio clock.
     * Recovery + cancellation are event-driven (the inbox).
     */
    [BILLING_DUNNING_KIND]: async (_job, ctx) => {
      await runDunning(ctx.pool, { now });
    },

    /**
     * Phase 6 · unit 6.1 — the hold-expiry sweep. GLOBAL (no tenant on the job):
     * one pass reclaims every expired, UN-frozen seat hold across tenants. The
     * frozen-guard lives in app.expire_holds (deletes only `not frozen`), so a
     * mid-tender hold is never reclaimed. Injected now, like the drains.
     */
    [BOOKING_EXPIRE_HOLDS_KIND]: async (_job, ctx) => {
      await runExpireHolds(ctx.pool, { now });
    },

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
      const minuteBucket = instant.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
      const independentlyEnqueuedKinds = [...GLOFOX_SYNC_KINDS, GLOFOX_RECONCILE_KIND] as const;
      for (const kind of independentlyEnqueuedKinds) {
        await ctx.pool.query(`select app.enqueue_job($1, $2, $3, now(), 100, 5, $4)`, [
          kind,
          // `cycle` = the hour bucket flows into the payload so a self-chaining
          // entity (credits: O(members), chunked, self-re-enqueuing) can thread
          // it into its per-chunk idempotency keys. Without a per-cycle token
          // its cursor-only keys are stable across runs and every chunk past
          // the first dedupes against the prior cycle — the credits walk then
          // silently stops at 500 members each cycle. Harmless to entities that
          // don't chain (they ignore payload.cycle).
          JSON.stringify({ cycle: hourBucket }),
          tenantId,
          `${kind}:${tenantId}:${hourBucket}`,
        ]);
      }

      // One ordered statement preserves the established query-count while the
      // day-keyed retention sweep trails all derivations.
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
         ), retention_job as (
           select app.enqueue_job($21, $22, $23, now(), 100, 5, $24) as id
           from briefing_job
         )
         select id from retention_job`,
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
          RETENTION_SWEEP_KIND,
          JSON.stringify({}),
          tenantId,
          `${RETENTION_SWEEP_KIND}:${tenantId}:${dayBucket}`,
        ],
      );

      // Billing spine (Phase 5 · unit 5.3): the inbox + outbox drains are GLOBAL
      // (stripe_events has no tenant_id; the outbox scopes per command row), so
      // they enqueue with a tenant-INDEPENDENT hour key — every tenant's fan-out
      // converges on ONE drain job per bucket (enqueue_job dedupes on
      // (kind, idempotency_key)). Interim hookup on the existing frequent
      // fan-out; the dedicated billing cadence lands with the schedule table
      // (unit 1.7). Tenant is NULL — these processors require no tenant on the job.
      for (const kind of [BILLING_PROCESS_INBOX_KIND, BILLING_PROCESS_OUTBOX_KIND]) {
        await ctx.pool.query(`select app.enqueue_job($1, $2, null, now(), 100, 5, $3)`, [
          kind,
          JSON.stringify({}),
          `${kind}:${hourBucket}`,
        ]);
      }

      // verify_money (Phase 5 · unit 5.5) is the NIGHTLY cross-ledger gate proof
      // — a DAY-scoped idempotency key (not the hourly bucket the drains use)
      // keeps the frequent fan-out to ONE verification per day. Global (tenant
      // NULL), like the drains; the dedicated nightly cadence lands with the
      // schedule table (unit 1.7).
      await ctx.pool.query(`select app.enqueue_job($1, $2, null, now(), 100, 5, $3)`, [
        BILLING_VERIFY_MONEY_KIND,
        JSON.stringify({}),
        `${BILLING_VERIFY_MONEY_KIND}:${dayBucket}`,
      ]);

      // The dunning clock (unit 5.6) is time-driven on a DAILY cadence — its
      // stage boundaries are day-scaled (grace 14d, reminder +7d). It is GLOBAL
      // (scans every tenant's open cycles) and day-keyed so the frequent fan-out
      // converges on ONE dunning pass per day per bucket.
      await ctx.pool.query(`select app.enqueue_job($1, $2, null, now(), 100, 5, $3)`, [
        BILLING_DUNNING_KIND,
        JSON.stringify({}),
        `${BILLING_DUNNING_KIND}:${dayBucket}`,
      ]);

      // The hold-expiry sweep (unit 6.1) reclaims expired UN-frozen seat holds.
      // Holds have a 300s default TTL, so the hour key the other drains use is
      // far too coarse — MINUTE-scoped key. NOTE: the tick cadence (the single
      // 5-minute Netlify scheduled function) is the REAL granularity bound; a
      // seat can linger up to one tick past its TTL. Acceptable — a held seat
      // only delays reuse, never oversells, and payment initiation FREEZES the
      // hold so tender is never reclaimed mid-flight. GLOBAL (tenant NULL).
      await ctx.pool.query(`select app.enqueue_job($1, $2, null, now(), 100, 5, $3)`, [
        BOOKING_EXPIRE_HOLDS_KIND,
        JSON.stringify({}),
        `${BOOKING_EXPIRE_HOLDS_KIND}:${minuteBucket}`,
      ]);

      // The waitlist sweep (unit 6.2) settles lapsed offers + cascade-promotes —
      // FREQUENT global pass, MINUTE-keyed like expire_holds. GLOBAL (tenant NULL).
      await ctx.pool.query(`select app.enqueue_job($1, $2, null, now(), 100, 5, $3)`, [
        WAITLIST_SWEEP_KIND,
        JSON.stringify({}),
        `${WAITLIST_SWEEP_KIND}:${minuteBucket}`,
      ]);

      // The no-show sweep is a DAILY per-tenant money event (forfeit) — day-keyed
      // and tenant-scoped so the frequent fan-out converges on ONE pass per
      // tenant per day.
      await ctx.pool.query(`select app.enqueue_job($1, $2, $3, now(), 100, 5, $4)`, [
        NO_SHOW_SWEEP_KIND,
        JSON.stringify({}),
        tenantId,
        `${NO_SHOW_SWEEP_KIND}:${tenantId}:${dayBucket}`,
      ]);
    },
  };
}
