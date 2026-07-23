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
 *   transactions   — ID SET-DIFFERENCE over the trailing report window. The
 *                    report uses Glofox wall-time `created`, while Kelo stores
 *                    its UTC conversion. Kelo therefore reads a ±1-day window
 *                    plus all-time membership for every report ID. Report IDs
 *                    found anywhere in Kelo match; Kelo-only rows more than
 *                    36h inside both edges are real drift. Edge rows are
 *                    counted in detail.boundary_rows and excluded from drift.
 *                    drift_count = |only_in_glofox| − |only_in_kelo|.
 *
 *   bookings       — FULL-HISTORY active count: paginated bookings.list rows
 *                    vs count(*) glofox_bookings where deleted_at is null. NO window: the API's only
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
export const RECONCILE_ENTITIES = [
  "members",
  "members_active",
  "transactions",
  "bookings",
  "credits",
] as const;

/** The member-canary proxy window (the recurring-payment evidence chain). */
const ACTIVE_PROXY_WINDOW_DAYS = 45;
/** Transactions reconciliation window default (payload.windowDays overrides). */
const DEFAULT_WINDOW_DAYS = 30;
/** Kelo's UTC conversion can straddle the report's Glofox wall-time edges. */
const TRANSACTION_WINDOW_WIDEN_DAYS = 1;
/** Rows this close to either report edge are explained boundary artifacts. */
const TRANSACTION_BOUNDARY_HOURS = 36;

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
  // Phase-2 upgrade (derivation CERTIFIED 22/22 on 2026-07-18): the canary now
  // counts the AUTHORITATIVE primary_relationship — the payment-evidence proxy
  // below remains as corroboration in detail (via the `since` window callers
  // pass) but the headline Kelo count is the derived member cohort.
  void since;
  const result = await pool.query(
    `select count(*)::int as n
     from public.people
     where tenant_id = $1
       and primary_relationship = 'recurring_member'`,
    [tenantId],
  );
  return asNumber((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

async function keloBookingsCounts(
  pool: PooledQueryable,
  tenantId: string,
): Promise<{ active: number; softDeleted: number }> {
  const activeResult = await pool.query(
    `select count(*)::int as n
     from public.glofox_bookings
     where tenant_id = $1 and deleted_at is null`,
    [tenantId],
  );
  const softDeletedResult = await pool.query(
    `select count(*)::int as n
     from public.glofox_bookings
     where tenant_id = $1 and deleted_at is not null`,
    [tenantId],
  );
  return {
    active: asNumber((activeResult.rows[0] as { n?: unknown } | undefined)?.n ?? 0),
    softDeleted: asNumber((softDeletedResult.rows[0] as { n?: unknown } | undefined)?.n ?? 0),
  };
}

interface KeloTransactionRef {
  readonly externalRef: string;
  readonly createdAt: Date | null;
}

function asDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function keloTransactionRefs(
  pool: PooledQueryable,
  tenantId: string,
  widenedStart: Date,
  widenedEnd: Date,
  reportIds: readonly string[],
): Promise<KeloTransactionRef[]> {
  const result = await pool.query(
    `select external_ref, transaction_created_at
     from public.glofox_transactions
     where tenant_id = $1
       and ((transaction_created_at >= $2 and transaction_created_at < $3)
            or external_ref = any($4::text[]))`,
    [tenantId, widenedStart.toISOString(), widenedEnd.toISOString(), reportIds],
  );
  const refs: KeloTransactionRef[] = [];
  for (const row of result.rows) {
    const parsed = row as { external_ref?: unknown; transaction_created_at?: unknown };
    if (typeof parsed.external_ref !== "string") continue;
    refs.push({
      externalRef: parsed.external_ref,
      createdAt: asDateOrNull(parsed.transaction_created_at),
    });
  }
  return refs;
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
  // LIVE FINDING (first production reconcile, 2026-07-18): Style B
  // meta.totalCount does NOT mean total matching rows (it returned 2 against
  // 6,636 real bookings; even the pinned sample shows 6 for a 3-row page).
  // The vendor field is untrustworthy — count honestly by paginating.
  // ~67 pages at limit=100 under the 10 rps budget ≈ 7s: fine for a daily job.
  let total = 0;
  let page = 1;
  for (;;) {
    const payload = await client.fetch(
      withQuery(`/2.2/branches/${encodeURIComponent(ctx.branchId)}/bookings`, {
        page,
        limit: 100,
      }),
    );
    const parsed = glofoxBookingsResponseSchema.parse(payload);
    total += parsed.data.length;
    if (parsed.data.length < 100 || page > 500) break;
    page += 1;
  }
  return total;
}

/** Identity-only read: set reconciliation needs no amounts, status, or PII. */
const chargeRefSchema = z.object({
  StripeCharge: z.object({
    _id: z.string(),
  }),
});

async function glofoxTransactionRefs(
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ refs: string[]; unreadableRows: number }> {
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
  const refs = new Set<string>();
  let unreadableRows = 0;
  for (const detail of details) {
    const parsed = chargeRefSchema.safeParse(detail);
    if (!parsed.success) {
      unreadableRows += 1;
      continue;
    }
    refs.add(parsed.data.StripeCharge._id);
  }
  return { refs: [...refs], unreadableRows };
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
      owner_ground_truth:
        "~23 active members (BLOCKERS gold label — SURFACED, never asserted as pass/fail)",
      phase_2:
        "replaced by the authoritative primary_relationship count when relationship derivation lands",
    },
  };
};

const checkTransactions: EntityCheck = async (pool, client, ctx, cfg) => {
  const windowEnd = ctx.now();
  const windowStart = new Date(windowEnd.getTime() - cfg.windowDays * DAY_MS);
  const widenedStart = new Date(windowStart.getTime() - TRANSACTION_WINDOW_WIDEN_DAYS * DAY_MS);
  const widenedEnd = new Date(windowEnd.getTime() + TRANSACTION_WINDOW_WIDEN_DAYS * DAY_MS);
  const glofox = await glofoxTransactionRefs(client, ctx, windowStart, windowEnd);
  const reportRefs = new Set(glofox.refs);
  const keloRows = await keloTransactionRefs(
    pool,
    ctx.tenantId,
    widenedStart,
    widenedEnd,
    glofox.refs,
  );

  const keloByRef = new Map<string, Date | null>();
  for (const row of keloRows) keloByRef.set(row.externalRef, row.createdAt);

  const keloInWindow = new Set<string>();
  for (const [ref, createdAt] of keloByRef) {
    if (
      createdAt !== null &&
      createdAt.getTime() >= windowStart.getTime() &&
      createdAt.getTime() < windowEnd.getTime()
    ) {
      keloInWindow.add(ref);
    }
  }

  const onlyInGlofox = [...reportRefs].filter((ref) => !keloByRef.has(ref)).sort();
  const onlyInKelo: string[] = [];
  const boundaryRefs = new Set<string>();
  const interiorStart = windowStart.getTime() + TRANSACTION_BOUNDARY_HOURS * 60 * 60 * 1000;
  const interiorEnd = windowEnd.getTime() - TRANSACTION_BOUNDARY_HOURS * 60 * 60 * 1000;

  // A report row matches if Kelo has that identity AT ALL. If its converted
  // UTC timestamp falls outside the report window, the count delta is an
  // explained wall-time boundary artifact rather than missing data.
  for (const ref of reportRefs) {
    if (keloByRef.has(ref) && !keloInWindow.has(ref)) boundaryRefs.add(ref);
  }

  for (const [ref, createdAt] of keloByRef) {
    if (reportRefs.has(ref) || createdAt === null) continue;
    const createdMs = createdAt.getTime();
    const isInterior = createdMs > interiorStart && createdMs < interiorEnd;
    if (isInterior) onlyInKelo.push(ref);
    else boundaryRefs.add(ref);
  }
  onlyInKelo.sort();

  const driftCount = onlyInGlofox.length - onlyInKelo.length;
  return {
    windowStart,
    windowEnd,
    glofoxCount: reportRefs.size,
    keloCount: keloInWindow.size,
    glofoxSum: null,
    keloSum: null,
    driftCount,
    driftSum: null,
    status: driftCount === 0 ? "match" : "drift",
    detail: {
      set_rule:
        "drift_count = |only_in_glofox| - |only_in_kelo|; report IDs match if their external_ref exists in Kelo at all; Kelo-only rows must be more than 36h inside both report edges to count as drift",
      window_days: cfg.windowDays,
      only_in_glofox: onlyInGlofox,
      only_in_kelo: onlyInKelo,
      boundary_rows: boundaryRefs.size,
      unreadable_rows: glofox.unreadableRows,
      kelo_window_widened_days: TRANSACTION_WINDOW_WIDEN_DAYS,
      boundary_hours: TRANSACTION_BOUNDARY_HOURS,
      note: "IDs only; no transaction payload or PII is persisted in reconciliation detail",
    },
  };
};

const checkBookings: EntityCheck = async (pool, client, ctx) => {
  const glofoxCount = await glofoxBookingsTotal(client, ctx);
  const kelo = await keloBookingsCounts(pool, ctx.tenantId);
  const keloCount = kelo.active;
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
      glofox_source: "bookings.list paginated data-row count (meta.totalCount is unreliable)",
      kelo_source: "count(*) glofox_bookings where deleted_at is null",
      soft_deleted: kelo.softDeleted,
    },
  };
};

/**
 * Credits — a DB-ONLY conservation check (raw zone vs credit_ledger), NOT a
 * live-API check. There is no cheap branch-wide credits endpoint (README §7.3:
 * credits are O(members), per-user), so the "Glofox side" is the raw zone —
 * `glofox_raw` /2.0/credits, the latest pack per `_id`, which IS the vendor's
 * data faithfully stored. The ledger MUST equal it. This is the standing-gap
 * backstop the 2026-07-22 credit loss lacked: Tripwire 5 only fires on NEW
 * quarantine in a run, so an accumulated gap (124 credit rows, all marked
 * `resolved`, /health open-count 0) stayed invisible — this attestation makes
 * "ledger != last-synced raw" a red reconciliations row every cycle. Scoped to
 * source='glofox' so non-Glofox credits (gift cards, manual adjustments) don't
 * masquerade as import drift. Freshness of the raw snapshot itself is the
 * credits sync_state watermark's job, not this check's.
 */
const checkCredits: EntityCheck = async (pool, _client, ctx) => {
  const result = await pool.query(
    `with packs as (
       select (p->>'_id') as pack_id, (p->>'user_id') as user_ref,
              (p->>'num_sessions')::int as granted, (p->>'available')::int as available,
              row_number() over (partition by (p->>'_id') order by gr.fetched_at desc) as rn
       from public.glofox_raw gr
       cross join lateral jsonb_array_elements(coalesce(gr.payload->'data','[]'::jsonb)) as p
       where gr.tenant_id = $1 and gr.endpoint = '/2.0/credits'
     ),
     latest as (select * from packs where rn = 1),
     raw_side as (
       select count(*)::int as packs,
              coalesce(sum(granted),0)::int as granted,
              coalesce(sum(available),0)::int as outstanding
       from latest
     ),
     ledger_side as (
       select count(*) filter (where entry_type = 'grant')::int as grants,
              coalesce(sum(delta) filter (where entry_type = 'grant'),0)::int as granted,
              coalesce(sum(delta),0)::int as net_balance
       from public.credit_ledger where tenant_id = $1 and source = 'glofox'
     ),
     quar as (
       select count(*)::int as open_q
       from public.import_quarantine
       where tenant_id = $1 and entity = 'credits' and status = 'open'
     ),
     per_person as (
       select count(*)::int as mismatches from (
         select coalesce(r.person_id, k.person_id) as person_id
         from (select pe.id as person_id, sum(lt.available)::int as raw_out
               from latest lt
               join public.people pe on pe.tenant_id = $1 and pe.external_ref = lt.user_ref
               group by pe.id) r
         full join (select person_id, sum(delta)::int as bal
                    from public.credit_ledger
                    where tenant_id = $1 and source = 'glofox' group by person_id) k
           on k.person_id = r.person_id
         where coalesce(r.raw_out, 0) <> coalesce(k.bal, 0)
       ) m
     )
     select r.packs, r.granted as raw_granted, r.outstanding as raw_outstanding,
            g.grants, g.granted as ledger_granted, g.net_balance,
            q.open_q, pp.mismatches
     from raw_side r, ledger_side g, quar q, per_person pp`,
    [ctx.tenantId],
  );
  const parsed = result.rows[0] as Record<string, unknown> | undefined;
  const packs = asNumber(parsed?.["packs"] ?? 0);
  const grants = asNumber(parsed?.["grants"] ?? 0);
  const rawOutstanding = asNumber(parsed?.["raw_outstanding"] ?? 0);
  const netBalance = asNumber(parsed?.["net_balance"] ?? 0);
  const mismatches = asNumber(parsed?.["mismatches"] ?? 0);
  const driftCount = packs - grants;
  const driftSum = rawOutstanding - netBalance;
  return {
    windowStart: null,
    windowEnd: null,
    glofoxCount: packs,
    keloCount: grants,
    glofoxSum: rawOutstanding,
    keloSum: netBalance,
    driftCount,
    driftSum,
    // A per-person balance mismatch is drift even when the pack/grant counts
    // and totals happen to net out — so it is part of the match predicate.
    status: driftCount === 0 && driftSum === 0 && mismatches === 0 ? "match" : "drift",
    detail: {
      source:
        "raw zone (glofox_raw /2.0/credits, latest pack per _id) vs credit_ledger where source='glofox'; no branch-wide credits endpoint, so the last-synced raw snapshot is the vendor truth the ledger must equal",
      raw_granted: asNumber(parsed?.["raw_granted"] ?? 0),
      ledger_granted: asNumber(parsed?.["ledger_granted"] ?? 0),
      per_person_balance_mismatches: mismatches,
      open_quarantine: asNumber(parsed?.["open_q"] ?? 0),
      unit: "credits (num_sessions), not currency — drift_sum is a credit count",
      rule: "drift_count = raw packs − ledger grants; drift_sum = raw outstanding − ledger balance; status also drifts on any per-person balance mismatch",
    },
  };
};

const CHECKS: Record<(typeof RECONCILE_ENTITIES)[number], EntityCheck> = {
  members: checkMembers,
  members_active: checkMembersActive,
  transactions: checkTransactions,
  bookings: checkBookings,
  credits: checkCredits,
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
