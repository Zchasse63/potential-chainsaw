import { mapStripeEvent, type StripeEventAction } from "@kelo/stripe";
import type { PooledQueryable } from "../glofox/types.js";

/**
 * Phase 5 · unit 5.3 — THE STRIPE INBOX PROCESSOR (the confirmation engine;
 * plan-final §5, threat-model §6). The signed webhook is the ONLY writer that
 * flips a payment to a terminal money state (invariant #5/#6): the receiver
 * durably records each event in the stripe_events inbox, and THIS processor —
 * running under the service-role pool — consumes the TABLE and applies the
 * money-state transition. It NEVER trusts the HTTP request.
 *
 * The inbox has NO tenant_id (migration 0033): events are global, and each
 * payment is located by its globally-unique stripe_payment_intent_id.
 *
 * GUARANTEES:
 *   - AT-LEAST-ONCE SAFE: only status='received' rows are claimed, so a
 *     reprocessed (already 'processed'/'ignored'/'error') event is never
 *     re-selected. The transition itself is idempotent — re-applying
 *     succeeded→succeeded is a no-op, and terminal states are never regressed
 *     (a late payment_failed can't unwind a succeeded/refunded payment).
 *   - ERROR ISOLATION: one bad event writes status='error' + error text and the
 *     loop CONTINUES with the next event (mirrors the reconcile engine). A throw
 *     escapes only if the inbox UPDATE itself fails (the DB is gone), letting the
 *     job layer back off.
 *   - UNKNOWN / UNHANDLED kinds are marked 'ignored' (quarantine-by-ignore,
 *     never a wrong money write); only the three money transitions this unit
 *     owns flip a payment.
 */

export const BILLING_PROCESS_INBOX_KIND = "stripe.process_inbox";

/** Default max events drained per run — the inbox is low-volume. */
const DEFAULT_BATCH = 50;
/** Inbox failures RETRY (event stays 'received') up to this many attempts —
 * a payment not-yet-linked by the outbox self-heals on a later drain — then
 * DEAD-LETTER to 'error' + a critical alert. Mirrors the outbox's bound. */
const DEFAULT_MAX_ATTEMPTS = 5;

export interface InboxDeps {
  /** Injectable clock (processed_at). Defaults to now; never Date.now in-body. */
  readonly now?: () => Date;
  /** Max events claimed per run. */
  readonly batch?: number;
  /** Attempts before a failing event is dead-lettered (default 5). */
  readonly maxAttempts?: number;
}

/** How one event was resolved — returned for tests and processor logging. */
export interface InboxOutcome {
  readonly eventId: string;
  readonly status: "processed" | "ignored" | "error" | "retrying";
  /** The money transition applied (present only when a payment was touched). */
  readonly transition?: string;
}

interface ClaimedEvent {
  readonly id: string;
  readonly eventId: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly accountId: string | null;
}

interface PaymentRef {
  readonly status: string;
  readonly amountCents: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function claimEvents(pool: PooledQueryable, batch: number): Promise<ClaimedEvent[]> {
  const result = await pool.query(
    `select id, event_id, payload, attempts, stripe_account_id
     from public.stripe_events
     where status = 'received'
     order by received_at asc
     limit $1`,
    [batch],
  );
  const events: ClaimedEvent[] = [];
  for (const row of result.rows) {
    const parsed = row as {
      id?: unknown;
      event_id?: unknown;
      payload?: unknown;
      attempts?: unknown;
      stripe_account_id?: unknown;
    };
    if (typeof parsed.id !== "string" || typeof parsed.event_id !== "string") continue;
    events.push({
      id: parsed.id,
      eventId: parsed.event_id,
      payload: parsed.payload,
      attempts: asNumber(parsed.attempts) ?? 0,
      accountId: typeof parsed.stripe_account_id === "string" ? parsed.stripe_account_id : null,
    });
  }
  return events;
}

async function selectPayment(
  pool: PooledQueryable,
  paymentIntentId: string,
): Promise<PaymentRef | null> {
  const result = await pool.query(
    `select status, amount_cents from public.payments where stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
  const row = asRecord(result.rows[0]);
  if (row === undefined) return null;
  const amount = asNumber(row["amount_cents"]);
  if (typeof row["status"] !== "string" || amount === null) return null;
  return { status: row["status"], amountCents: amount };
}

/**
 * Flip the payment to `target`, but ONLY from an allowed prior state — a
 * terminal money state is never regressed. Located by the globally-unique
 * stripe_payment_intent_id; setting the same status again is a safe no-op.
 */
async function setPaymentStatus(
  pool: PooledQueryable,
  paymentIntentId: string,
  target: string,
  allowedPrior: readonly string[],
): Promise<void> {
  await pool.query(
    `update public.payments
     set status = $1
     where stripe_payment_intent_id = $2
       and status = any($3::text[])`,
    [target, paymentIntentId, allowedPrior],
  );
}

/** A refund event carries the CUMULATIVE amount_refunded; full when the boolean
 * `refunded` is set or the cumulative amount covers the charge. */
function refundTarget(
  payment: PaymentRef,
  action: Extract<StripeEventAction, { kind: "charge_refunded" }>,
): string {
  if (action.refunded === true) return "refunded";
  if (action.amountRefunded !== undefined && action.amountRefunded >= payment.amountCents) {
    return "refunded";
  }
  return "partially_refunded";
}

/**
 * Apply one event's money transition. Returns the transition name applied, or
 * null for a known-but-unhandled / unknown kind (→ 'ignored'). Throws on a
 * genuine failure (e.g. the event references a payment we never created), which
 * the caller records as status='error' in isolation.
 */
async function applyTransition(
  pool: PooledQueryable,
  action: StripeEventAction,
): Promise<string | null> {
  switch (action.kind) {
    case "payment_succeeded": {
      const payment = await selectPayment(pool, action.paymentIntentId);
      if (payment === null) {
        throw new Error(`no payment for payment_intent ${action.paymentIntentId}`);
      }
      // A PaymentIntent may legitimately go failed→succeeded on a retry, so
      // 'failed' is an allowed prior; a refunded payment is never un-refunded.
      await setPaymentStatus(pool, action.paymentIntentId, "succeeded", [
        "requires_payment",
        "processing",
        "failed",
        "succeeded",
      ]);
      return "succeeded";
    }
    case "payment_failed": {
      const payment = await selectPayment(pool, action.paymentIntentId);
      if (payment === null) {
        throw new Error(`no payment for payment_intent ${action.paymentIntentId}`);
      }
      // Never regress a succeeded/refunded payment to failed (out-of-order
      // delivery), but a repeated failure is an idempotent no-op.
      await setPaymentStatus(pool, action.paymentIntentId, "failed", [
        "requires_payment",
        "processing",
        "failed",
      ]);
      return "failed";
    }
    case "charge_refunded": {
      if (action.paymentIntentId === undefined) {
        throw new Error(`charge.refunded ${action.chargeId} has no payment_intent to reconcile`);
      }
      const payment = await selectPayment(pool, action.paymentIntentId);
      if (payment === null) {
        throw new Error(`no payment for payment_intent ${action.paymentIntentId}`);
      }
      const target = refundTarget(payment, action);
      // Refunds are MONOTONIC — a full 'refunded' is terminal and must never
      // regress to 'partially_refunded' when Stripe delivers a partial-refund
      // event AFTER the completing one (webhook ordering is not guaranteed). So
      // the allowed prior states depend on the target: a full refund may apply
      // from succeeded/partial/refunded (idempotent); a partial refund may apply
      // only from succeeded/partial — NEVER from an already-full refund.
      const allowedPrior =
        target === "refunded"
          ? ["succeeded", "partially_refunded", "refunded"]
          : ["succeeded", "partially_refunded"];
      await setPaymentStatus(pool, action.paymentIntentId, target, allowedPrior);
      return target;
    }
    // Known-but-unhandled here (subscriptions/invoices land in a later unit) and
    // truly unknown ('ignored') alike apply NO money transition.
    default:
      return null;
  }
}

async function markEvent(
  pool: PooledQueryable,
  id: string,
  status: "processed" | "ignored" | "error",
  error: string | null,
  now: Date,
): Promise<void> {
  await pool.query(
    `update public.stripe_events
     set status = $1, processed_at = $2, error = $3
     where id = $4`,
    [status, now.toISOString(), error, id],
  );
}

/**
 * A per-event failure is RETRYABLE — the referenced payment may simply not be
 * linked yet by the outbox (self-healing on a later drain). Keep the event
 * 'received' and bump attempts until the bound, THEN dead-letter to 'error' +
 * a critical alert so a genuinely-stranded money event is operator-visible
 * (the release rule's production-visible health signal). Returns the terminal
 * inbox status for this drain: 'error' if dead-lettered, else 'retrying'.
 */
async function handleEventFailure(
  pool: PooledQueryable,
  event: ClaimedEvent,
  message: string,
  now: Date,
  maxAttempts: number,
): Promise<"error" | "retrying"> {
  const attempts = event.attempts + 1;
  if (attempts < maxAttempts) {
    await pool.query(
      `update public.stripe_events
       set attempts = $1, error = $2
       where id = $3 and status = 'received'`,
      [attempts, message, event.id],
    );
    return "retrying";
  }
  await pool.query(
    `update public.stripe_events
     set status = 'error', attempts = $1, error = $2, processed_at = $3
     where id = $4`,
    [attempts, message, now.toISOString(), event.id],
  );
  // Dead-letter alert, tenant-resolved via the connected account (best-effort:
  // a real money event always carries an account that maps to a tenant). The
  // partial unique index dedupes per open alert.
  await pool.query(
    `insert into public.alerts (tenant_id, kind, severity, title, body, dedupe_key, context)
     select sa.tenant_id, 'stripe_event_failed', 'critical', $2, $3, $4, $5
     from public.stripe_accounts sa
     where sa.stripe_account_id = $1
     on conflict (tenant_id, kind, dedupe_key) where status = 'open' do nothing`,
    [
      event.accountId,
      `Stripe event dead-lettered after ${attempts} attempts`,
      message,
      event.eventId,
      JSON.stringify({ event_id: event.eventId, attempts }),
    ],
  );
  return "error";
}

/**
 * Drain the stripe_events inbox. NEVER throws for a per-event failure — the
 * 'error' row IS the failure surface (one bad event must not blind the others).
 */
export async function runInbox(
  pool: PooledQueryable,
  deps: InboxDeps = {},
): Promise<InboxOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? DEFAULT_BATCH;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const events = await claimEvents(pool, batch);
  const outcomes: InboxOutcome[] = [];

  for (const event of events) {
    const instant = now();
    try {
      const action = mapStripeEvent(event.payload);
      const transition = await applyTransition(pool, action);
      const status = transition === null ? "ignored" : "processed";
      await markEvent(pool, event.id, status, null, instant);
      outcomes.push(
        transition === null
          ? { eventId: event.eventId, status }
          : { eventId: event.eventId, status, transition },
      );
    } catch (err) {
      const message = (err instanceof Error ? err.message : "unknown inbox error").slice(0, 1_000);
      const status = await handleEventFailure(pool, event, message, instant, maxAttempts);
      outcomes.push({ eventId: event.eventId, status });
    }
  }

  return outcomes;
}
