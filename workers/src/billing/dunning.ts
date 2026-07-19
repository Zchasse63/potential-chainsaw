import { nextAllowedSendAt } from "@kelo/comms";
import type { PooledQueryable } from "../glofox/types.js";

/**
 * Phase 5 · unit 5.6 — THE DUNNING STATE MACHINE (plan-final §5). Stripe Billing
 * owns invoice RETRIES (Smart Retries); Kelo owns the comms/workflow. This module
 * is that workflow, split into two clocks that share ONE writer
 * (app.record_dunning_stage):
 *
 *   EVENT-DRIVEN (the inbox, inbox.ts): a failed invoice STARTS a grace cycle; a
 *   succeeded invoice RECOVERS it; a Stripe-side cancellation CLOSES it. These
 *   are seeded here as startDunning / recoverDunning / cancelDunning.
 *
 *   TIME-DRIVEN (the 'billing.dunning' processor, runDunning): +7d unresolved →
 *   a reminder; grace expiry unresolved → final notice → past_due.
 *
 * The ledger is the state: the CURRENT stage is the latest dunning_states row.
 * Every transition is idempotent — the decision (nextTimedTransitions, and the
 * open-cycle guards on the inbox helpers) reads the latest stage first, and
 * app.record_dunning_stage is a no-op when the target stage already holds.
 * A subscription is NEVER auto-cancelled — 'cancelled' only mirrors Stripe.
 */

export const BILLING_DUNNING_KIND = "billing.dunning";

/** Owner default grace window (plan-final §5): a failed invoice has 14 days. */
export const DEFAULT_GRACE_WINDOW_DAYS = 14;
/** The mid-grace reminder nudge fires this many days after the failure. */
export const DEFAULT_REMINDER_AFTER_DAYS = 7;
/** Subscriptions scanned per time-driven run — dunning is low-volume. */
const DEFAULT_BATCH = 200;

export type DunningStage =
  | "grace_started"
  | "reminder_sent"
  | "final_notice"
  | "past_due"
  | "recovered"
  | "cancelled";

/** The stages that mean a dunning cycle is still OPEN (recoverable/closeable). */
const OPEN_STAGES: readonly DunningStage[] = [
  "grace_started",
  "reminder_sent",
  "final_notice",
  "past_due",
];

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ALL_STAGES: readonly DunningStage[] = [
  "grace_started",
  "reminder_sent",
  "final_notice",
  "past_due",
  "recovered",
  "cancelled",
];

function asStage(value: unknown): DunningStage | null {
  return typeof value === "string" && (ALL_STAGES as readonly string[]).includes(value)
    ? (value as DunningStage)
    : null;
}

/** The subscription id + tenant for an inbox-driven transition. */
export interface SubscriptionRef {
  readonly id: string;
  readonly tenantId: string;
}

/** Look up our subscription by its Stripe id. null when we do not track it yet
 * (subscription creation is a later unit); the inbox treats that as 'ignored'
 * rather than a dead-letter. */
export async function selectSubscriptionByStripeId(
  pool: PooledQueryable,
  stripeSubscriptionId: string,
): Promise<SubscriptionRef | null> {
  const result = await pool.query(
    `select id, tenant_id from public.subscriptions where stripe_subscription_id = $1`,
    [stripeSubscriptionId],
  );
  const row = asRecord(result.rows[0]);
  if (row === undefined) return null;
  if (typeof row["id"] !== "string" || typeof row["tenant_id"] !== "string") return null;
  return { id: row["id"], tenantId: row["tenant_id"] };
}

export type SubscriptionStatus =
  | "incomplete"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled";

/**
 * WIDEN-THEN-CLASSIFY the Stripe subscription status onto the Kelo enum (mirrors
 * the glofox_event discipline, invariant #8). An unknown status returns null —
 * the caller leaves subscriptions.status untouched, NEVER throwing.
 *   trialing/active            → active
 *   past_due                   → past_due   (Stripe-reported; the machine also owns it)
 *   paused                     → paused
 *   canceled/unpaid            → cancelled  (terminal)
 *   incomplete/incomplete_expired → incomplete
 */
export function mapSubscriptionStatus(
  stripeStatus: string | undefined,
): SubscriptionStatus | null {
  switch (stripeStatus) {
    case "trialing":
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
    case "unpaid":
      return "cancelled";
    case "incomplete":
    case "incomplete_expired":
      return "incomplete";
    default:
      return null;
  }
}

export interface SyncSubscriptionArgs {
  readonly sub: SubscriptionRef;
  readonly status?: string;
  /** Unix seconds from the Stripe object. */
  readonly currentPeriodEnd?: number;
  /** customer.subscription.deleted forces the terminal 'cancelled'. */
  readonly deleted?: boolean;
  /**
   * The Stripe EVENT's `created` (unix seconds) — the EVENT-TIME MONOTONICITY
   * clock (F6). A status change applies ONLY when this is newer than the last
   * applied event (subscriptions.last_event_at); an older/out-of-order webhook
   * is a benign no-op, so a delayed event can never regress a PAID/CANCELLED
   * member back into an earlier state. Undefined (no created) applies as before.
   */
  readonly eventCreatedAt?: number;
}

/**
 * Sync subscriptions.status + current_period_end from a Stripe subscription
 * event. MONOTONIC in TWO ways: on the terminal 'cancelled' (a cancelled
 * subscription is never revived by a stale update), AND on EVENT TIME — the
 * whole update is gated on eventCreatedAt > last_event_at, and last_event_at is
 * advanced in the SAME guarded UPDATE, so unordered/delayed webhooks cannot
 * regress status (F6). An unknown Stripe status leaves the status untouched
 * while still syncing current_period_end. The service role owns this write —
 * the webhook is the authority (invariant #5).
 */
export async function syncSubscriptionStatus(
  pool: PooledQueryable,
  args: SyncSubscriptionArgs,
): Promise<void> {
  const target = args.deleted === true ? "cancelled" : mapSubscriptionStatus(args.status);
  const periodEnd =
    typeof args.currentPeriodEnd === "number" && Number.isFinite(args.currentPeriodEnd)
      ? new Date(args.currentPeriodEnd * 1_000).toISOString()
      : null;
  const createdAt =
    typeof args.eventCreatedAt === "number" && Number.isFinite(args.eventCreatedAt)
      ? args.eventCreatedAt
      : null;

  await pool.query(
    `update public.subscriptions s
     set status = case
                    when $3::text is null then s.status
                    when s.status = 'cancelled' then s.status
                    else $3::text
                  end,
         current_period_end = coalesce($4::timestamptz, s.current_period_end),
         last_event_at = coalesce(to_timestamp($5::double precision), s.last_event_at)
     where s.id = $1 and s.tenant_id = $2
       and ($5::double precision is null
            or s.last_event_at is null
            or s.last_event_at < to_timestamp($5::double precision))`,
    [args.sub.id, args.sub.tenantId, target, periodEnd, createdAt],
  );
}

/** The subscription's latest (current) dunning stage, or null when it has never
 * entered dunning. */
export async function selectLatestStage(
  pool: PooledQueryable,
  tenantId: string,
  subscriptionId: string,
): Promise<DunningStage | null> {
  const result = await pool.query(
    `select stage from public.dunning_states
     where tenant_id = $1 and subscription_id = $2
     order by occurred_at desc, created_at desc, id desc
     limit 1`,
    [tenantId, subscriptionId],
  );
  const row = asRecord(result.rows[0]);
  return row === undefined ? null : asStage(row["stage"]);
}

/** The stages whose SQL writer ALSO enqueues a member-facing dunning comms row
 * (app.record_dunning_stage; kind transactional_quiet). Only these need the
 * quiet-hours-aware run_at deferral (F5). */
const COMMS_BEARING_STAGES: readonly DunningStage[] = ["grace_started", "reminder_sent"];

/** The studio send window used to defer a dunning comms job's run_at (F5). */
interface SendContext {
  readonly timezone: string;
  readonly quietStart: string;
  readonly quietEnd: string;
}

function quietSetting(settings: Record<string, unknown> | null, key: "start" | "end"): string {
  const fallback = key === "start" ? "21:00" : "09:00";
  if (settings === null) return fallback;
  const direct = settings[`quiet_${key}`];
  if (typeof direct === "string") return direct;
  const quietHours = settings["quiet_hours"];
  if (typeof quietHours === "object" && quietHours !== null) {
    const nested = (quietHours as Record<string, unknown>)[key];
    if (typeof nested === "string") return nested;
  }
  return fallback;
}

/** Resolve the tenant's studio timezone (first location, UTC fallback) + quiet
 * window from tenants.settings — the SAME inputs the send processor's at-send
 * policy re-check uses, so the deferred run_at lands in an actually-allowed
 * window rather than being terminally skipped there (F5). */
async function resolveSendContext(pool: PooledQueryable, tenantId: string): Promise<SendContext> {
  const result = await pool.query(
    `select
       coalesce((
         select l.timezone from public.locations l
         where l.tenant_id = $1
         order by l.created_at, l.id
         limit 1
       ), 'UTC') as timezone,
       t.settings as settings
     from public.tenants t
     where t.id = $1`,
    [tenantId],
  );
  const row = asRecord(result.rows[0]);
  const timezone = typeof row?.["timezone"] === "string" ? row["timezone"] : "UTC";
  const settings = asRecord(row?.["settings"]) ?? null;
  return {
    timezone,
    quietStart: quietSetting(settings, "start"),
    quietEnd: quietSetting(settings, "end"),
  };
}

export interface RecordStageArgs {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly stage: DunningStage;
  readonly now: Date;
  readonly paymentId?: string | null;
  readonly graceExpiresAt?: Date | null;
  readonly detail?: Record<string, unknown>;
}

/**
 * Append one transition through the single SQL writer. Idempotent in-body (a
 * re-call at the current stage is a no-op). For the two COMMS-BEARING stages,
 * the send job's run_at is deferred to the next ALLOWED studio-local time so a
 * quiet-hours-blocked reminder is DELIVERED LATER instead of being terminally
 * skipped and lost (F5). The stage transition and the comms enqueue happen
 * together inside record_dunning_stage's single transaction — if the enqueue
 * raises, the stage does NOT advance and the next daily pass retries.
 */
export async function recordStage(pool: PooledQueryable, args: RecordStageArgs): Promise<void> {
  let runAt = args.now;
  if (COMMS_BEARING_STAGES.includes(args.stage)) {
    const ctx = await resolveSendContext(pool, args.tenantId);
    runAt = nextAllowedSendAt(args.now, ctx.timezone, ctx.quietStart, ctx.quietEnd);
  }
  await pool.query(
    `select app.record_dunning_stage($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      args.tenantId,
      args.subscriptionId,
      args.stage,
      args.paymentId ?? null,
      args.now.toISOString(),
      args.graceExpiresAt ? args.graceExpiresAt.toISOString() : null,
      JSON.stringify(args.detail ?? {}),
      runAt.toISOString(),
    ],
  );
}

function isOpen(stage: DunningStage | null): boolean {
  return stage !== null && OPEN_STAGES.includes(stage);
}

/**
 * The TENANT-CONFIGURED dunning grace window (F7): tenants.settings.
 * 'dunning_grace_days', default 14. The same tenant-setting discipline the
 * recurring_member derivation / revenue dictionary already apply — the grace
 * window is a per-tenant policy, never a hardcoded 14. Resolved once, wherever
 * grace_expires_at / stage boundaries are computed.
 */
export async function resolveDunningGraceDays(
  pool: PooledQueryable,
  tenantId: string,
): Promise<number> {
  const result = await pool.query(
    `select coalesce(nullif(t.settings ->> 'dunning_grace_days', '')::int, $2) as grace_days
     from public.tenants t
     where t.id = $1`,
    [tenantId, DEFAULT_GRACE_WINDOW_DAYS],
  );
  const row = asRecord(result.rows[0]);
  const n = Number(row?.["grace_days"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRACE_WINDOW_DAYS;
}

export interface StartDunningArgs {
  readonly sub: SubscriptionRef;
  readonly now: Date;
  /** Explicit override; when omitted the tenant's configured grace is read (F7). */
  readonly graceWindowDays?: number;
  readonly paymentId?: string | null;
  readonly detail?: Record<string, unknown>;
}

/**
 * EVENT-DRIVEN start (invoice.payment_failed). Opens a grace cycle ONCE: Stripe
 * fires a payment_failed for every retry, so a subscription already in an open
 * cycle is left untouched (idempotent). Returns true when a cycle was started.
 * The grace window is the tenant's configured value (F7) unless overridden.
 */
export async function startDunning(pool: PooledQueryable, args: StartDunningArgs): Promise<boolean> {
  const latest = await selectLatestStage(pool, args.sub.tenantId, args.sub.id);
  if (isOpen(latest)) return false;
  const graceWindowDays =
    args.graceWindowDays ?? (await resolveDunningGraceDays(pool, args.sub.tenantId));
  const graceExpiresAt = addDays(args.now, graceWindowDays);
  await recordStage(pool, {
    tenantId: args.sub.tenantId,
    subscriptionId: args.sub.id,
    stage: "grace_started",
    now: args.now,
    paymentId: args.paymentId ?? null,
    graceExpiresAt,
    detail: args.detail,
  });
  return true;
}

/**
 * EVENT-DRIVEN recovery (invoice.payment_succeeded). Closes an OPEN cycle back to
 * active with grace cleared; a subscription not in dunning is untouched. Returns
 * true when a recovery was recorded.
 */
export async function recoverDunning(
  pool: PooledQueryable,
  args: { sub: SubscriptionRef; now: Date; paymentId?: string | null },
): Promise<boolean> {
  const latest = await selectLatestStage(pool, args.sub.tenantId, args.sub.id);
  if (!isOpen(latest)) return false;
  await recordStage(pool, {
    tenantId: args.sub.tenantId,
    subscriptionId: args.sub.id,
    stage: "recovered",
    now: args.now,
    paymentId: args.paymentId ?? null,
  });
  return true;
}

/**
 * EVENT-DRIVEN cancellation (customer.subscription.deleted). Records a 'cancelled'
 * ledger entry to CLOSE an open cycle — mirroring the Stripe-side cancellation,
 * never auto-cancelling. A subscription not in dunning gets no ledger noise
 * (its subscriptions.status is synced separately by the inbox). Returns true
 * when a close was recorded.
 */
export async function cancelDunning(
  pool: PooledQueryable,
  args: { sub: SubscriptionRef; now: Date },
): Promise<boolean> {
  const latest = await selectLatestStage(pool, args.sub.tenantId, args.sub.id);
  if (!isOpen(latest)) return false;
  await recordStage(pool, {
    tenantId: args.sub.tenantId,
    subscriptionId: args.sub.id,
    stage: "cancelled",
    now: args.now,
  });
  return true;
}

/** The current dunning state of one subscription, as the time-driven scan reads it. */
export interface DunningState {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly latestStage: DunningStage;
  readonly graceStartedAt: Date | null;
  readonly graceExpiresAt: Date | null;
}

export interface TimedConfig {
  readonly reminderAfterDays: number;
}

/**
 * THE PURE TIME-DRIVEN DECISION. Given a subscription's current dunning state and
 * the studio clock, returns the ordered stages to append now (possibly empty).
 *   grace expiry unresolved  → ['final_notice', 'past_due']
 *   a crash-left final_notice → ['past_due']
 *   +reminderAfterDays in grace → ['reminder_sent']
 * Recovery/cancellation are event-driven (the inbox), never time-driven.
 */
export function nextTimedTransitions(
  state: DunningState,
  now: Date,
  cfg: TimedConfig,
): DunningStage[] {
  const { latestStage, graceStartedAt, graceExpiresAt } = state;

  if (
    graceExpiresAt !== null &&
    now.getTime() >= graceExpiresAt.getTime() &&
    (latestStage === "grace_started" || latestStage === "reminder_sent")
  ) {
    return ["final_notice", "past_due"];
  }

  if (latestStage === "final_notice") {
    return ["past_due"];
  }

  if (
    latestStage === "grace_started" &&
    graceStartedAt !== null &&
    now.getTime() >= addDays(graceStartedAt, cfg.reminderAfterDays).getTime()
  ) {
    return ["reminder_sent"];
  }

  return [];
}

async function claimOpenDunning(pool: PooledQueryable, batch: number): Promise<DunningState[]> {
  // Only cycles that still advance on the clock: past_due is terminal for the
  // time-driven scan (only an event recovers or cancels it). grace_started_at is
  // the current cycle's failure instant (reminder timing); grace_expires_at lives
  // on the subscription (set when the cycle opened).
  const result = await pool.query(
    `select
       s.id as subscription_id,
       s.tenant_id,
       s.grace_expires_at,
       latest.stage as latest_stage,
       gs.occurred_at as grace_started_at
     from public.subscriptions s
     join lateral (
       select ds.stage
       from public.dunning_states ds
       where ds.tenant_id = s.tenant_id and ds.subscription_id = s.id
       order by ds.occurred_at desc, ds.created_at desc, ds.id desc
       limit 1
     ) latest on true
     join lateral (
       select ds.occurred_at
       from public.dunning_states ds
       where ds.tenant_id = s.tenant_id and ds.subscription_id = s.id
         and ds.stage = 'grace_started'
       order by ds.occurred_at desc, ds.created_at desc, ds.id desc
       limit 1
     ) gs on true
     where latest.stage in ('grace_started', 'reminder_sent', 'final_notice')
     order by s.tenant_id, s.id
     limit $1`,
    [batch],
  );

  const states: DunningState[] = [];
  for (const raw of result.rows) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const stage = asStage(row["latest_stage"]);
    if (
      typeof row["subscription_id"] !== "string" ||
      typeof row["tenant_id"] !== "string" ||
      stage === null
    ) {
      continue;
    }
    states.push({
      subscriptionId: row["subscription_id"],
      tenantId: row["tenant_id"],
      latestStage: stage,
      graceStartedAt: asDate(row["grace_started_at"]),
      graceExpiresAt: asDate(row["grace_expires_at"]),
    });
  }
  return states;
}

export interface DunningDeps {
  /** Injectable clock (studio time for day-boundary decisions). */
  readonly now?: () => Date;
  readonly reminderAfterDays?: number;
  readonly batch?: number;
}

/** One subscription's outcome for a time-driven run (for tests + logging). */
export interface DunningOutcome {
  readonly subscriptionId: string;
  readonly appended: DunningStage[];
}

/**
 * THE TIME-DRIVEN PROCESSOR ('billing.dunning'). GLOBAL (no tenant on the job):
 * it scans every open dunning cycle across tenants, computes the next transitions
 * per subscription, and appends them through the single SQL writer. Idempotent —
 * a re-run over unchanged state appends nothing (the past_due terminal drops out
 * of the claim; a not-yet-due reminder yields no transition).
 */
export async function runDunning(
  pool: PooledQueryable,
  deps: DunningDeps = {},
): Promise<DunningOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const reminderAfterDays = deps.reminderAfterDays ?? DEFAULT_REMINDER_AFTER_DAYS;
  const batch = deps.batch ?? DEFAULT_BATCH;
  const states = await claimOpenDunning(pool, batch);
  const outcomes: DunningOutcome[] = [];

  for (const state of states) {
    const instant = now();
    const stages = nextTimedTransitions(state, instant, { reminderAfterDays });
    for (const stage of stages) {
      await recordStage(pool, {
        tenantId: state.tenantId,
        subscriptionId: state.subscriptionId,
        stage,
        now: instant,
      });
    }
    if (stages.length > 0) {
      outcomes.push({ subscriptionId: state.subscriptionId, appended: stages });
    }
  }

  return outcomes;
}
