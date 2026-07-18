import { z } from "zod";
import { glofoxBookingsResponseSchema, glofoxMembersResponseSchema } from "@kelo/contracts";
import { buildAnalyticsReportRequest } from "@kelo/glofox";
import { openAlert } from "../pipeline.js";
import { extractTransactionsRows, toUnixSeconds, withQuery } from "../envelopes.js";
import type { PooledQueryable, SyncGlofoxClient, SyncRunContext } from "../types.js";

/**
 * Phase 1 · unit 5 — THE RECONCILIATION ENGINE (plan-final §4 "Reconciliation
 * — the trust engine and the cutover meter"; tripwire 5 of the five in-system
 * freshness tripwires). NEGATIVE BRANCH (owner-confirmed 2026-07-17): no
 * Stripe ingest pre-cutover, so revenue reconciliation is the Glofox
 * transactions report vs Kelo's imported glofox_transactions — the SAME source
 * both sides, so drift means an import bug, which is exactly what this catches.
 *
 * Per entity, compute Glofox-side and Kelo-side counts/sums and write ONE
 * reconciliations row (migration 0011 — the PINNED shape unit 1.6 reads):
 *
 *   members        — Glofox members.list total_count (Style A carries it; page
 *                    1 with limit=1 reads it WITHOUT pulling all rows) filtered
 *                    active=true vs count(*) people where active. Same
 *                    population both sides: people.active mirrors the Glofox
 *                    soft-delete flag (README §6). drift_count = glofox − kelo
 *                    (signed; nonzero either way is drift).
 *
 *   members_active — THE ACTIVE-MEMBER CANARY vs the owner's ~23 ground truth.
 *                    Relationship derivation is PHASE 2, so the phase-1 Kelo
 *                    PROXY is the recurring-payment evidence chain (README §5):
 *                    count(distinct person) on glofox_transactions where
 *                    glofox_event_class='subscription_payment' in the trailing
 *                    45 days (any status — an ERROR subscription payment is a
 *                    failing RECURRING member and still evidences the
 *                    relationship). The Glofox-side equivalent (membership.type
 *                    != 'payg') needs a full ~1500-row pull — NOT cheap, so the
 *                    row is SINGLE-SIDED: glofox_count NULL, status 'match',
 *                    the expected ~23 in detail (BLOCKERS gold label —
 *                    SURFACED, never hardcoded as pass/fail). Phase 2 replaces
 *                    the proxy with the authoritative primary_relationship
 *                    count.
 *
 *   transactions   — THE MONEY RECONCILIATION. Window = trailing 30 days
 *                    (payload.windowDays override). Glofox side = the report
 *                    details; Kelo side = glofox_transactions in the same
 *                    window. NET rule, IDENTICAL both sides: count = PAID +
 *                    REFUNDED rows; sum = PAID amounts − REFUNDED amounts
 *                    (ERROR rows are failed payments — no money moved — and are
 *                    excluded from the net on BOTH sides; every status still
 *                    appears in detail's per-status breakdown). Report rows
 *                    that fail the lenient {status, amount} read are counted in
 *                    detail.unreadable_rows and excluded (the import mapper
 *                    quarantines the same rows — visible, never silent).
 *
 *   bookings       — FULL-HISTORY count: bookings.list meta.totalCount vs
 *                    count(*) glofox_bookings. NO window: the API's only
 *                    bookings filter is modified_start_date, which has no
 *                    Kelo-side counterpart (glofox_bookings.updated_at is
 *                    re-touched by every re-import), so any windowed comparison
 *                    would be skewed by construction; the full count is the
 *                    apples-to-apples check — same population rule as members.
 *
 * RULES:
 *   - ONE ENTITY'S FAILURE NEVER BLINDS THE OTHERS: any fetch/compute error
 *     writes a reconciliations row status='error' (message in detail), opens a
 *     'reconciliation_error' warning alert (deduped per tenant+entity), and the
 *     run CONTINUES with the next entity.
 *   - DRIFT IS LOUD: any 'drift' row opens/REFRESHES a 'reconciliation_drift'
 *     alert (deduped per tenant+entity; a refresh keeps the LATEST numbers
 *     visible). Severity: warning for any nonzero drift; critical when
 *     |drift_sum| > driftCriticalMoney (default $100) or |drift_count| >
 *     driftCriticalCount (default 10) — both payload-overridable. Any nonzero
 *     money drift is always at least a warning (there is no noise floor).
 *   - Rows are written in the service-role pool as plain SQL (the 1.4/0010
 *     pattern); alerts reuse the pipeline's openAlert (same dedupe index).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The canonical entity set + order (payload.entities filters THIS list). */
export const RECONCILE_ENTITIES = ["members", "members_active", "transactions", "bookings"] as const;

/** The member-canary proxy window (the recurring-payment evidence chain). */
const ACTIVE_PROXY_WINDOW_DAYS = 45;
/** Transactions reconciliation window default (payload.windowDays overrides). */
const DEFAULT_WINDOW_DAYS = 30;

export interface ReconcileConfig {
  readonly entities: readonly string[];
  readonly windowDays: number;
  readonly driftCriticalMoney: number;
  readonly driftCriticalCount: number;
}

/** Job-payload overrides, defensively typed (payload is arbitrary JSON). */
export function reconcileConfigFromPayload(payload: Record<string, unknown>): ReconcileConfig {
  const rawEntities = payload["entities"];
  const entities = Array.isArray(rawEntities)
    ? RECONCILE_ENTITIES.filter((e) => rawEntities.includes(e))
    : RECONCILE_ENTITIES;
  const windowDays = payload["windowDays"];
  const criticalMoney = payload["driftCriticalMoney"];
  const criticalCount = payload["driftCriticalCount"];
  return {
    entities: entities.length > 0 ? entities : RECONCILE_ENTITIES,
    windowDays:
      typeof windowDays === "number" && Number.isFinite(windowDays) && windowDays > 0
        ? windowDays
        : DEFAULT_WINDOW_DAYS,
    driftCriticalMoney:
      typeof criticalMoney === "number" && criticalMoney >= 0 ? criticalMoney : 100,
    driftCriticalCount:
      typeof criticalCount === "number" && criticalCount >= 0 ? criticalCount : 10,
  };
}

/** How one entity's check ended — returned for tests and processor logging. */
export interface ReconcileOutcome {
  readonly entity: string;
  readonly status: "match" | "drift" | "error";
  readonly glofoxCount: number | null;
  readonly keloCount: number | null;
  readonly driftCount: number | null;
  readonly driftSum: number | null;
}

/** One reconciliations row, pre-insert (the engine owns the insert). */
interface ReconRow {
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly glofoxCount: number | null;
  readonly keloCount: number | null;
  readonly glofoxSum: number | null;
  readonly keloSum: number | null;
  readonly driftCount: number | null;
  readonly driftSum: number | null;
  readonly status: "match" | "drift" | "error";
  readonly detail: Record<string, unknown>;
}

/** pg returns numbers for the ::int/::float8 casts below; coerce defensively. */
function asNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a numeric result, got ${String(value)}`);
  return n;
}

/** Money drift compares at cents precision — float fuzz is not drift. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

async function insertReconciliation(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  entity: string,
  row: ReconRow,
): Promise<void> {
  await pool.query(
    `insert into public.reconciliations (
       tenant_id, entity, window_start, window_end,
       glofox_count, kelo_count, glofox_sum, kelo_sum, drift_count, drift_sum,
       status, detail, checked_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.tenantId,
      entity,
      row.windowStart?.toISOString() ?? null,
      row.windowEnd?.toISOString() ?? null,
      row.glofoxCount,
      row.keloCount,
      row.glofoxSum,
      row.keloSum,
      row.driftCount,
      row.driftSum,
      row.status,
      JSON.stringify(row.detail),
      ctx.now().toISOString(),
    ],
  );
}

/**
 * The drift alert OPENS OR REFRESHES (plan: "opens/refreshes"): the pipeline's
 * openAlert dedupes insert-only, but a recurring drift must show the LATEST
 * numbers (and escalate severity), so the conflict path updates in place.
 * Same partial unique index (tenant_id, kind, dedupe_key) where status='open'.
 */
async function openOrRefreshDriftAlert(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  entity: string,
  alert: { severity: "warning" | "critical"; title: string; body: string },
): Promise<void> {
  await pool.query(
    `insert into public.alerts (tenant_id, kind, severity, title, body, dedupe_key, context)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, kind, dedupe_key) where status = 'open'
     do update set severity = excluded.severity, title = excluded.title,
                   body = excluded.body, context = excluded.context`,
    [
      ctx.tenantId,
      "reconciliation_drift",
      alert.severity,
      alert.title,
      alert.body,
      entity,
      JSON.stringify({ entity }),
    ],
  );
}

// --- Kelo-side counts ------------------------------------------------------------

async function keloActivePeopleCount(pool: PooledQueryable, tenantId: string): Promise<number> {
  const result = await pool.query(
    `select count(*)::int as n from public.people where tenant_id = $1 and active`,
    [tenantId],
  );
  return asNumber((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

async function keloActiveMemberProxyCount(
  pool: PooledQueryable,
  tenantId: string,
  since: Date,
): Promise<number> {
  const result = await pool.query(
    `select count(distinct person_external_ref)::int as n
     from public.glofox_transactions
     where tenant_id = $1
       and glofox_event_class = 'subscription_payment'
       and person_external_ref is not null
       and transaction_created_at >= $2`,
    [tenantId, since.toISOString()],
  );
  return asNumber((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

async function keloBookingsCount(pool: PooledQueryable, tenantId: string): Promise<number> {
  const result = await pool.query(
    `select count(*)::int as n from public.glofox_bookings where tenant_id = $1`,
    [tenantId],
  );
  return asNumber((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

interface StatusBreakdown {
  readonly count: number;
  readonly sum: number;
}

async function keloTransactionBreakdown(
  pool: PooledQueryable,
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Record<string, StatusBreakdown>> {
  const result = await pool.query(
    `select transaction_status as status, count(*)::int as n,
            coalesce(sum(amount), 0)::float8 as total
     from public.glofox_transactions
     where tenant_id = $1 and transaction_created_at >= $2 and transaction_created_at < $3
     group by transaction_status`,
    [tenantId, windowStart.toISOString(), windowEnd.toISOString()],
  );
  const breakdown: Record<string, StatusBreakdown> = {};
  for (const row of result.rows) {
    const r = row as { status?: unknown; n?: unknown; total?: unknown };
    if (typeof r.status !== "string") continue;
    breakdown[r.status] = { count: asNumber(r.n ?? 0), sum: money(asNumber(r.total ?? 0)) };
  }
  return breakdown;
}

// --- Glofox-side reads (strict envelope parse: schema drift here is LOUD — it
// becomes an 'error' row, never a wrong number) -------------------------------

async function glofoxActiveMembersTotal(client: SyncGlofoxClient): Promise<number> {
  const payload = await client.fetch(
    withQuery("/2.0/members", { page: 1, limit: 1, active: "true" }),
  );
  return glofoxMembersResponseSchema.parse(payload).total_count;
}

async function glofoxBookingsTotal(client: SyncGlofoxClient, ctx: SyncRunContext): Promise<number> {
  if (ctx.branchId === undefined) throw new Error("bookings reconciliation requires ctx.branchId");
  const payload = await client.fetch(
    withQuery(`/2.2/branches/${encodeURIComponent(ctx.branchId)}/bookings`, { page: 1, limit: 1 }),
  );
  return glofoxBookingsResponseSchema.parse(payload).meta.totalCount;
}

/** Lenient per-row read for the money totals — the mapper owns the STRICT row;
 * reconciliation needs only {status, amount}. Failures are counted, not fatal. */
const chargeTotalsSchema = z.object({
  StripeCharge: z.object({
    transaction_status: z.string(),
    amount: z.number(),
  }),
});

async function glofoxTransactionBreakdown(
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ breakdown: Record<string, StatusBreakdown>; unreadableRows: number }> {
  if (ctx.branchId === undefined || ctx.namespace === undefined) {
    // Trap 2 is a SILENT EMPTY report — missing identity config must be loud.
    throw new Error("transactions reconciliation requires ctx.branchId and ctx.namespace");
  }
  const body = buildAnalyticsReportRequest({
    branch_id: ctx.branchId,
    namespace: ctx.namespace,
    start: String(toUnixSeconds(windowStart)),
    end: String(toUnixSeconds(windowEnd)),
    model: "TransactionsList",
  });
  const payload = await client.fetch("/Analytics/report", { method: "POST", body });
  const details = extractTransactionsRows(payload);
  const breakdown: Record<string, StatusBreakdown> = {};
  let unreadableRows = 0;
  for (const detail of details) {
    const parsed = chargeTotalsSchema.safeParse(detail);
    if (!parsed.success) {
      unreadableRows += 1;
      continue;
    }
    const { transaction_status: status, amount } = parsed.data.StripeCharge;
    const prior = breakdown[status] ?? { count: 0, sum: 0 };
    breakdown[status] = { count: prior.count + 1, sum: money(prior.sum + amount) };
  }
  return { breakdown, unreadableRows };
}

/** The NET money rule — IDENTICAL both sides (the module header documents it). */
function netTotals(breakdown: Record<string, StatusBreakdown>): { count: number; sum: number } {
  const paid = breakdown["PAID"] ?? { count: 0, sum: 0 };
  const refunded = breakdown["REFUNDED"] ?? { count: 0, sum: 0 };
  return { count: paid.count + refunded.count, sum: money(paid.sum - refunded.sum) };
}

// --- the per-entity checks ------------------------------------------------------

type EntityCheck = (
  pool: PooledQueryable,
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
  cfg: ReconcileConfig,
) => Promise<ReconRow>;

const checkMembers: EntityCheck = async (pool, client, ctx) => {
  const glofoxCount = await glofoxActiveMembersTotal(client);
  const keloCount = await keloActivePeopleCount(pool, ctx.tenantId);
  const driftCount = glofoxCount - keloCount;
  return {
    windowStart: null,
    windowEnd: null,
    glofoxCount,
    keloCount,
    glofoxSum: null,
    keloSum: null,
    driftCount,
    driftSum: null,
    status: driftCount === 0 ? "match" : "drift",
    detail: {
      population: "active members (people.active mirrors the Glofox soft-delete flag)",
      glofox_source: "GET /2.0/members total_count (active=true; page 1, limit 1)",
      kelo_source: "count(*) people where tenant_id and active",
    },
  };
};

const checkMembersActive: EntityCheck = async (pool, _client, ctx) => {
  const windowEnd = ctx.now();
  const windowStart = new Date(windowEnd.getTime() - ACTIVE_PROXY_WINDOW_DAYS * DAY_MS);
  const keloCount = await keloActiveMemberProxyCount(pool, ctx.tenantId, windowStart);
  return {
    windowStart,
    windowEnd,
    glofoxCount: null, // single-sided canary — see detail
    keloCount,
    glofoxSum: null,
    keloSum: null,
    driftCount: null,
    driftSum: null,
    status: "match",
    detail: {
      phase_1_proxy: true,
      rule: `count(distinct person_external_ref) on glofox_transactions where glofox_event_class = 'subscription_payment' in the trailing ${ACTIVE_PROXY_WINDOW_DAYS} days (any status)`,
      evidence_chain: "README §5: recurring = membership.type + subscription_payment evidence",
      window_days: ACTIVE_PROXY_WINDOW_DAYS,
      single_sided:
        "the Glofox-side equivalent (members with membership.type != 'payg') needs a full ~1500-row pull — not cheap; the owner eyeballs kelo_count against ground truth instead",
      owner_ground_truth: "~23 active members (BLOCKERS gold label — SURFACED, never asserted as pass/fail)",
      phase_2: "replaced by the authoritative primary_relationship count when relationship derivation lands",
    },
  };
};

const checkTransactions: EntityCheck = async (pool, client, ctx, cfg) => {
  const windowEnd = ctx.now();
  const windowStart = new Date(windowEnd.getTime() - cfg.windowDays * DAY_MS);
  const glofox = await glofoxTransactionBreakdown(client, ctx, windowStart, windowEnd);
  const kelo = await keloTransactionBreakdown(pool, ctx.tenantId, windowStart, windowEnd);
  const glofoxNet = netTotals(glofox.breakdown);
  const keloNet = netTotals(kelo);
  const driftCount = glofoxNet.count - keloNet.count;
  const driftSum = money(glofoxNet.sum - keloNet.sum);
  return {
    windowStart,
    windowEnd,
    glofoxCount: glofoxNet.count,
    keloCount: keloNet.count,
    glofoxSum: glofoxNet.sum,
    keloSum: keloNet.sum,
    driftCount,
    driftSum,
    status: driftCount === 0 && driftSum === 0 ? "match" : "drift",
    detail: {
      net_rule:
        "count = PAID + REFUNDED rows; sum = PAID amounts − REFUNDED amounts (ERROR rows are failed payments, excluded from the net on BOTH sides)",
      window_days: cfg.windowDays,
      glofox_by_status: glofox.breakdown,
      kelo_by_status: kelo,
      unreadable_rows: glofox.unreadableRows,
      note: "same source both sides — drift means an import bug, which is exactly what this check exists to catch",
    },
  };
};

const checkBookings: EntityCheck = async (pool, client, ctx) => {
  const glofoxCount = await glofoxBookingsTotal(client, ctx);
  const keloCount = await keloBookingsCount(pool, ctx.tenantId);
  const driftCount = glofoxCount - keloCount;
  return {
    windowStart: null,
    windowEnd: null,
    glofoxCount,
    keloCount,
    glofoxSum: null,
    keloSum: null,
    driftCount,
    driftSum: null,
    status: driftCount === 0 ? "match" : "drift",
    detail: {
      window: "full-history",
      why_no_window:
        "bookings.list filters only by modified_start_date, which has no Kelo-side counterpart (glofox_bookings.updated_at is re-touched by every re-import) — the full count is the apples-to-apples check",
      glofox_source: "bookings.list meta.totalCount (page 1, limit 1)",
      kelo_source: "count(*) glofox_bookings",
    },
  };
};

const CHECKS: Record<(typeof RECONCILE_ENTITIES)[number], EntityCheck> = {
  members: checkMembers,
  members_active: checkMembersActive,
  transactions: checkTransactions,
  bookings: checkBookings,
};

// --- the engine ------------------------------------------------------------------

/**
 * Run every configured entity check. NEVER throws for a per-entity failure —
 * the error row + alert IS the failure surface (one entity's failure must not
 * blind the others). A throw means the DB itself is gone (the reconciliations
 * insert failed) — the job layer's fail/backoff applies.
 */
export async function runReconciliation(
  pool: PooledQueryable,
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
): Promise<ReconcileOutcome[]> {
  const cfg = reconcileConfigFromPayload(ctx.payload);
  const outcomes: ReconcileOutcome[] = [];

  for (const entity of cfg.entities) {
    const check = CHECKS[entity as keyof typeof CHECKS];
    let row: ReconRow;
    try {
      row = await check(pool, client, ctx, cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      row = {
        windowStart: null,
        windowEnd: null,
        glofoxCount: null,
        keloCount: null,
        glofoxSum: null,
        keloSum: null,
        driftCount: null,
        driftSum: null,
        status: "error",
        detail: { error: message },
      };
      await openAlert(pool, ctx, entity, {
        kind: "reconciliation_error",
        severity: "warning",
        title: `${entity} reconciliation failed: ${message.slice(0, 120)}`,
        body: message,
      });
    }

    await insertReconciliation(pool, ctx, entity, row);

    if (row.status === "drift") {
      // TRIPWIRE 5 — drift is loud. Severity: warning for any nonzero drift;
      // critical past the configurable thresholds (module header).
      const severity: "warning" | "critical" =
        (row.driftSum !== null && Math.abs(row.driftSum) > cfg.driftCriticalMoney) ||
        (row.driftCount !== null && Math.abs(row.driftCount) > cfg.driftCriticalCount)
          ? "critical"
          : "warning";
      const driftBits = [
        row.driftCount !== null ? `Δcount ${row.driftCount}` : null,
        row.driftSum !== null ? `Δ$${row.driftSum.toFixed(2)}` : null,
      ]
        .filter((b) => b !== null)
        .join(", ");
      await openOrRefreshDriftAlert(pool, ctx, entity, {
        severity,
        title: `${entity} reconciliation drift: glofox ${row.glofoxCount ?? "?"} vs kelo ${row.keloCount ?? "?"} (${driftBits})`,
        body:
          `The ${entity} reconciliation found drift (glofox_count=${row.glofoxCount ?? "null"}, ` +
          `kelo_count=${row.keloCount ?? "null"}, glofox_sum=${row.glofoxSum ?? "null"}, ` +
          `kelo_sum=${row.keloSum ?? "null"}). Same source both sides — drift means an import ` +
          `bug; investigate before trusting downstream numbers.\n\n` +
          JSON.stringify(row.detail, null, 2),
      });
    }

    outcomes.push({
      entity,
      status: row.status,
      glofoxCount: row.glofoxCount,
      keloCount: row.keloCount,
      driftCount: row.driftCount,
      driftSum: row.driftSum,
    });
  }

  return outcomes;
}
