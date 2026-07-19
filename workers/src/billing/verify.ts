import type { PooledQueryable } from "../glofox/types.js";

/**
 * Phase 5 · unit 5.5 — VERIFY_MONEY (plan-final §5/§6, threat-model §6: the
 * phase-5 gate proofs). A NIGHTLY cross-ledger invariant sweep over the billing
 * spine — payments, stripe_commands, stripe_events — that proves the money
 * ledgers are internally consistent. It is GLOBAL (one run scans every tenant),
 * IDEMPOTENT (a re-run recomputes from the same rows), and — the load-bearing
 * property — READ-ONLY over the ledgers by construction: its ONLY writes are one
 * append-once public.verify_runs row and the deduped alerts it opens. It issues
 * NO update/insert against payments/stripe_commands/stripe_events (the chaos +
 * unit tests assert exactly that; a stray write is a defect).
 *
 * The invariants (each violation → an entry in the run's violations array + a
 * deduped alert, mirroring the reconcile engine's open/refresh):
 *
 *   1. terminal_paid_without_intent — every STRIPE payment in a terminal-PAID
 *      state (succeeded / refunded / partially_refunded) MUST carry a
 *      stripe_payment_intent_id. A paid stripe payment with no intent id is money
 *      the webhook could never have confirmed against a real object → CRITICAL.
 *      TENDER-SCOPED (unit 5.7): a CASH sale (tender='cash') is operator-attested
 *      with no webhook and no intent id, so it is excluded — not a violation.
 *   2. command_without_payment / command_with_multiple_payments — the intent
 *      layer↔payment linkage, checked BOTH directions: every 'sent'/'confirmed'
 *      create_payment_intent command has exactly one linked payment (a sent
 *      command with none is an integrity gap; one command fanning out to two
 *      payments is a double-write). payments.command_id is single-valued, so
 *      "a payment linked to two commands" is impossible by construction — the
 *      meaningful inverse is one command claimed by two payments.
 *   3. over_refund — no payment's total refunded (the sum of its non-failed
 *      create_refund commands) exceeds the payment amount. A breach is a real
 *      money-loss path → CRITICAL.
 *   4. stuck_outbox_command — a command still 'pending' past the delivery SLA
 *      (default 30 min): the outbox has not driven it to Stripe. WARNING.
 *   5. stuck_inbox_event / dead_lettered_events — an event still 'received'
 *      past the SLA (the inbox has not applied it), and the count of 'error'
 *      (dead-lettered) events surfaced. WARNING.
 *   6. dead_lettered_command — a stripe_commands row that exhausted its outbox
 *      retries (status 'failed'): an intended charge/refund that will NEVER
 *      reach Stripe until an operator intervenes. Tenant-scoped → deduped alert
 *      to the owner. CRITICAL (money is stuck).
 *
 * The command KIND literals here are the RPC-emitted ones the tables actually
 * hold ('create_payment_intent' / 'create_refund' — migration 0034), NOT the
 * outbox's adapter-dispatch kinds; verify reads the persisted ledger.
 */

export const BILLING_VERIFY_MONEY_KIND = "billing.verify_money";

/** A command left 'pending' / an event left 'received' longer than this is
 * stuck (the drain isn't keeping up). Injectable via deps.staleAfterMinutes. */
const DEFAULT_STALE_AFTER_MINUTES = 30;

export interface VerifyDeps {
  /** Injectable clock (started_at/finished_at + the SLA cutoff). Never Date.now. */
  readonly now?: () => Date;
  /** Minutes a pending command / received event may sit before it is stuck. */
  readonly staleAfterMinutes?: number;
}

type Severity = "warning" | "critical";

/** One invariant breach: the check that found it, its severity, the owning
 * tenant (null for a genuinely global/unresolved event breach), and detail. */
export interface Violation {
  readonly check: string;
  readonly severity: Severity;
  readonly tenantId: string | null;
  readonly detail: Record<string, unknown>;
}

/** How the run ended — returned for the processor log and tests. */
export interface VerifyOutcome {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a numeric result, got ${String(value)}`);
  return n;
}

// --- the individual checks (each pure SELECT; the ledgers are never mutated) ---

async function checkTerminalPaidWithoutIntent(pool: PooledQueryable): Promise<Violation[]> {
  // TENDER-SCOPED (unit 5.7): only a STRIPE terminal-paid payment must carry an
  // intent id. A CASH sale (payments.tender='cash') is operator-attested with no
  // webhook and legitimately has no stripe_payment_intent_id — flagging it would
  // make every counter cash sale a false CRITICAL violation.
  const result = await pool.query(
    `select id, tenant_id, status
     from public.payments
     where status in ('succeeded', 'refunded', 'partially_refunded')
       and tender = 'stripe'
       and stripe_payment_intent_id is null`,
  );
  return result.rows.map((raw) => {
    const row = raw as { id?: unknown; tenant_id?: unknown; status?: unknown };
    return {
      check: "terminal_paid_without_intent",
      severity: "critical" as const,
      tenantId: asString(row.tenant_id),
      detail: { payment_id: asString(row.id), status: asString(row.status) },
    };
  });
}

async function checkCommandWithoutPayment(pool: PooledQueryable): Promise<Violation[]> {
  const result = await pool.query(
    `select sc.id, sc.tenant_id
     from public.stripe_commands sc
     where sc.kind = 'create_payment_intent'
       and sc.status in ('sent', 'confirmed')
       and not exists (
         select 1 from public.payments p
         where p.tenant_id = sc.tenant_id and p.command_id = sc.id
       )`,
  );
  return result.rows.map((raw) => {
    const row = raw as { id?: unknown; tenant_id?: unknown };
    return {
      check: "command_without_payment",
      severity: "warning" as const,
      tenantId: asString(row.tenant_id),
      detail: { command_id: asString(row.id) },
    };
  });
}

async function checkCommandWithMultiplePayments(pool: PooledQueryable): Promise<Violation[]> {
  const result = await pool.query(
    `select command_id, tenant_id, count(*)::int as n
     from public.payments
     where command_id is not null
     group by tenant_id, command_id
     having count(*) > 1`,
  );
  return result.rows.map((raw) => {
    const row = raw as { command_id?: unknown; tenant_id?: unknown; n?: unknown };
    return {
      check: "command_with_multiple_payments",
      severity: "critical" as const,
      tenantId: asString(row.tenant_id),
      detail: { command_id: asString(row.command_id), payment_count: asNumber(row.n) },
    };
  });
}

async function checkOverRefund(pool: PooledQueryable): Promise<Violation[]> {
  // Total refunded = sum of the payment's non-failed create_refund commands
  // (payload.payment_id links to the payment; payload.amount_cents is the
  // refund amount). A payment with no refund commands can never over-refund, so
  // the inner join is correct — only refunded payments are considered.
  const result = await pool.query(
    `select p.id, p.tenant_id, p.amount_cents,
            coalesce(sum((sc.payload ->> 'amount_cents')::int), 0)::int as refunded
     from public.payments p
     join public.stripe_commands sc
       on sc.tenant_id = p.tenant_id
      and sc.kind = 'create_refund'
      and sc.status <> 'failed'
      and (sc.payload ->> 'payment_id') = p.id::text
     group by p.id, p.tenant_id, p.amount_cents
     having coalesce(sum((sc.payload ->> 'amount_cents')::int), 0) > p.amount_cents`,
  );
  return result.rows.map((raw) => {
    const row = raw as {
      id?: unknown;
      tenant_id?: unknown;
      amount_cents?: unknown;
      refunded?: unknown;
    };
    return {
      check: "over_refund",
      severity: "critical" as const,
      tenantId: asString(row.tenant_id),
      detail: {
        payment_id: asString(row.id),
        amount_cents: asNumber(row.amount_cents),
        refunded_cents: asNumber(row.refunded),
      },
    };
  });
}

async function checkStuckOutbox(pool: PooledQueryable, cutoff: Date): Promise<Violation[]> {
  const result = await pool.query(
    `select id, tenant_id, kind, created_at
     from public.stripe_commands
     where status = 'pending' and created_at < $1`,
    [cutoff.toISOString()],
  );
  return result.rows.map((raw) => {
    const row = raw as { id?: unknown; tenant_id?: unknown; kind?: unknown; created_at?: unknown };
    return {
      check: "stuck_outbox_command",
      severity: "warning" as const,
      tenantId: asString(row.tenant_id),
      detail: {
        command_id: asString(row.id),
        kind: asString(row.kind),
        created_at: asString(row.created_at),
      },
    };
  });
}

async function checkStuckInbox(pool: PooledQueryable, cutoff: Date): Promise<Violation[]> {
  // Events have no tenant_id — resolve the owning tenant through the connected
  // account (the inbox dead-letter path does the same). An unresolved account
  // leaves tenantId null (a global breach surfaced only in the run record).
  const result = await pool.query(
    `select se.id, se.event_id, sa.tenant_id
     from public.stripe_events se
     left join public.stripe_accounts sa
       on sa.stripe_account_id = se.stripe_account_id
     where se.status = 'received' and se.received_at < $1`,
    [cutoff.toISOString()],
  );
  return result.rows.map((raw) => {
    const row = raw as { id?: unknown; event_id?: unknown; tenant_id?: unknown };
    return {
      check: "stuck_inbox_event",
      severity: "warning" as const,
      tenantId: asString(row.tenant_id),
      detail: { event_row_id: asString(row.id), event_id: asString(row.event_id) },
    };
  });
}

async function checkFailedCommands(pool: PooledQueryable): Promise<Violation[]> {
  // A stripe_commands row that exhausted its outbox retries (status 'failed') is
  // a DEAD money command — an intended charge/refund that will NEVER reach
  // Stripe until an operator intervenes. Tenant-scoped (commands carry
  // tenant_id) so the alert reaches the owner. CRITICAL: money is stuck.
  const result = await pool.query(
    `select id, tenant_id, kind, last_error
     from public.stripe_commands
     where status = 'failed'`,
  );
  return result.rows.map((raw) => {
    const row = raw as {
      id?: unknown;
      tenant_id?: unknown;
      kind?: unknown;
      last_error?: unknown;
    };
    return {
      check: "dead_lettered_command",
      severity: "critical" as const,
      tenantId: asString(row.tenant_id),
      detail: {
        command_id: asString(row.id),
        kind: asString(row.kind),
        last_error: asString(row.last_error),
      },
    };
  });
}

async function checkDeadLetteredEvents(pool: PooledQueryable): Promise<Violation[]> {
  const result = await pool.query(
    `select count(*)::int as n from public.stripe_events where status = 'error'`,
  );
  const n = asNumber((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  if (n === 0) return [];
  return [
    {
      check: "dead_lettered_events",
      severity: "warning",
      tenantId: null,
      detail: { count: n },
    },
  ];
}

// --- alerting (deduped like the reconcile engine's open/refresh) ----------------

/**
 * Open OR refresh one verify_money alert per (tenant, check). Same partial
 * unique index (tenant_id, kind, dedupe_key) where status='open' as every other
 * alert, so a recurring nightly breach refreshes in place rather than spamming.
 * Only fires for a resolved tenant: a null-tenant breach cannot be deduped by
 * that index (NULLs are distinct) and would spam, so it is surfaced ONLY in the
 * verify_runs record — never as a client-invisible null-tenant alert.
 */
async function openOrRefreshAlert(
  pool: PooledQueryable,
  tenantId: string,
  check: string,
  severity: Severity,
  count: number,
): Promise<void> {
  await pool.query(
    `insert into public.alerts (tenant_id, kind, severity, title, body, dedupe_key, context)
     values ($1, 'verify_money', $2, $3, $4, $5, $6)
     on conflict (tenant_id, kind, dedupe_key) where status = 'open'
     do update set severity = excluded.severity, title = excluded.title,
                   body = excluded.body, context = excluded.context`,
    [
      tenantId,
      severity,
      `verify_money: ${count} ${check} violation${count === 1 ? "" : "s"}`,
      `The nightly money verification found ${count} '${check}' invariant breach` +
        `${count === 1 ? "" : "es"} for this tenant. Investigate before trusting the ` +
        `billing ledgers; the run's verify_runs row lists every offender.`,
      check,
      JSON.stringify({ check, count }),
    ],
  );
}

async function raiseAlerts(pool: PooledQueryable, violations: readonly Violation[]): Promise<void> {
  // Group by (tenant, check); one alert per group at the group's max severity.
  const groups = new Map<string, { tenantId: string; check: string; severity: Severity; count: number }>();
  for (const v of violations) {
    if (v.tenantId === null) continue; // surfaced only in the run record
    const key = `${v.tenantId} ${v.check}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { tenantId: v.tenantId, check: v.check, severity: v.severity, count: 1 });
    } else {
      existing.count += 1;
      if (v.severity === "critical") existing.severity = "critical";
    }
  }
  for (const g of groups.values()) {
    await openOrRefreshAlert(pool, g.tenantId, g.check, g.severity, g.count);
  }
}

// --- the engine ----------------------------------------------------------------

/**
 * Run every cross-ledger invariant check, record ONE append-once verify_runs
 * row (tenant_id null — the run is global), and open/refresh a deduped
 * verify_money alert per (tenant, check). The ledgers themselves are never
 * mutated: only verify_runs is inserted and alerts are upserted. Idempotent.
 */
export async function runVerifyMoney(
  pool: PooledQueryable,
  deps: VerifyDeps = {},
): Promise<VerifyOutcome> {
  const now = deps.now ?? (() => new Date());
  const staleAfterMinutes = deps.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;
  const startedAt = now();
  const cutoff = new Date(startedAt.getTime() - staleAfterMinutes * 60 * 1000);

  const violations: Violation[] = [
    ...(await checkTerminalPaidWithoutIntent(pool)),
    ...(await checkCommandWithoutPayment(pool)),
    ...(await checkCommandWithMultiplePayments(pool)),
    ...(await checkOverRefund(pool)),
    ...(await checkStuckOutbox(pool, cutoff)),
    ...(await checkStuckInbox(pool, cutoff)),
    ...(await checkFailedCommands(pool)),
    ...(await checkDeadLetteredEvents(pool)),
  ];

  const ok = violations.length === 0;
  const finishedAt = now();

  await pool.query(
    `insert into public.verify_runs (tenant_id, started_at, finished_at, ok, violations)
     values (null, $1, $2, $3, $4)`,
    [startedAt.toISOString(), finishedAt.toISOString(), ok, JSON.stringify(violations)],
  );

  await raiseAlerts(pool, violations);

  return { ok, violations };
}
