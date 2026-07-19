import { mapStripeEvent, type StripeEventAction } from "@kelo/stripe";
import type { PooledQueryable } from "../glofox/types.js";
import {
  cancelDunning,
  recoverDunning,
  selectSubscriptionByStripeId,
  startDunning,
  syncSubscriptionStatus,
} from "./dunning.js";

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
  /** Injectable clock (processed_at + dunning grace anchor). Never Date.now in-body. */
  readonly now?: () => Date;
  /** Max events claimed per run. */
  readonly batch?: number;
  /** Attempts before a failing event is dead-lettered (default 5). */
  readonly maxAttempts?: number;
  /**
   * Explicit dunning grace-window override in days (tests). When omitted, the
   * grace window is read PER-TENANT from tenants.settings.dunning_grace_days
   * (default 14) inside startDunning — never a hardcoded value (F7).
   */
  readonly graceWindowDays?: number;
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

/**
 * POS gift-card issuance seam (unit 5.7). A stripe-tender pos_checkout defers
 * gift-card issuance to payment success: after the payment flips to 'succeeded',
 * find the POS order behind this intent and issue its un-issued gift-card lines
 * through app.issue_order_gift_cards. That RPC is GATED on the order's payment
 * being succeeded and IDEMPOTENT (issued_at is null + FOR UPDATE), so at-least-
 * once redelivery issues each card exactly once. A non-POS payment (no order)
 * simply matches no row and is a no-op.
 */
async function issueGiftCardsForPaidIntent(
  pool: PooledQueryable,
  paymentIntentId: string,
): Promise<void> {
  const located = await pool.query(
    `select o.tenant_id, o.id
     from public.pos_orders o
     join public.payments p
       on p.id = o.payment_id and p.tenant_id = o.tenant_id
     where p.stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
  const row = asRecord(located.rows[0]);
  if (row === undefined) return;
  const tenantId = row["tenant_id"];
  const orderId = row["id"];
  if (typeof tenantId !== "string" || typeof orderId !== "string") return;
  await pool.query(`select app.issue_order_gift_cards($1, $2)`, [tenantId, orderId]);
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
 * THE MONOTONIC MONEY-STATE ORDER — defined in exactly ONE place. A payment's
 * status only ever advances along this axis; the webhook confirmation authority
 * (invariant #5/#6) never walks it backwards.
 *
 *   requires_payment < processing < failed < succeeded
 *                    < partially_refunded < refunded
 *
 * `failed` sits BELOW `succeeded` on purpose (retry semantics): a PaymentIntent
 * may go failed→succeeded on a later card retry, so a `succeeded` event must be
 * able to advance a `failed` payment — while a late/duplicate `failed` event can
 * never regress a payment that has already reached `succeeded` (or beyond). That
 * asymmetry is exactly "current status is AHEAD of the target ⇒ benign no-op".
 */
const MONEY_STATE_ORDER: readonly string[] = [
  "requires_payment",
  "processing",
  "failed",
  "succeeded",
  "partially_refunded",
  "refunded",
];

/** Rank on the monotonic axis; an unrecognised status is -1 (treated as behind
 * everything, so it can never be classified as a benign forward no-op). */
function moneyRank(status: string): number {
  return MONEY_STATE_ORDER.indexOf(status);
}

/**
 * Flip the payment to `target`, but ONLY from an allowed prior state — a
 * terminal money state is never regressed. Located by the globally-unique
 * stripe_payment_intent_id; setting the same status again is a safe no-op.
 * Returns true iff a row actually matched the guard (RETURNING makes a 0-row
 * no-op observable so the caller can distinguish "already ahead" from "not yet
 * caught up" — the lost-early-refund guard, F1).
 */
async function setPaymentStatus(
  pool: PooledQueryable,
  paymentIntentId: string,
  target: string,
  allowedPrior: readonly string[],
): Promise<boolean> {
  const result = await pool.query(
    `update public.payments
     set status = $1
     where stripe_payment_intent_id = $2
       and status = any($3::text[])
     returning id`,
    [target, paymentIntentId, allowedPrior],
  );
  return result.rows.length > 0;
}

/**
 * Apply a guarded money transition and classify a 0-row no-op (F1). When the
 * guarded UPDATE matches nothing, the current status is either:
 *   - MONOTONICALLY AHEAD of the target (e.g. already 'refunded' when a partial
 *     refund arrives, or 'succeeded' when a stale 'failed' arrives) → a benign,
 *     idempotent no-op; nothing to do.
 *   - BEHIND the target (e.g. still 'requires_payment'/'processing' when a
 *     refund arrives before payment_intent.succeeded has landed) → the confirming
 *     event has not been applied yet, so we THROW: the inbox keeps the event
 *     'received' and a later drain lands it after succeeded arrives (and the
 *     bounded-retry path dead-letters + alerts if it never does). Without this,
 *     the refund would be silently marked 'processed' and permanently lost.
 */
async function applyGuardedTransition(
  pool: PooledQueryable,
  paymentIntentId: string,
  target: string,
  allowedPrior: readonly string[],
): Promise<void> {
  const matched = await setPaymentStatus(pool, paymentIntentId, target, allowedPrior);
  if (matched) return;

  const current = await selectPayment(pool, paymentIntentId);
  if (current === null) {
    throw new Error(`payment for payment_intent ${paymentIntentId} vanished mid-transition`);
  }
  const currentRank = moneyRank(current.status);
  const targetRank = moneyRank(target);
  // Ahead-or-equal ⇒ the money state already covers this event (idempotent).
  if (currentRank >= targetRank && currentRank !== -1) return;
  // Behind ⇒ the confirming event has not landed; retry until it does.
  throw new Error(
    `payment ${paymentIntentId} is behind target '${target}' (currently '${current.status}') — ` +
      `the confirming event has not been applied yet; retrying`,
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
  now: Date,
  graceWindowDays: number | undefined,
): Promise<string | null> {
  switch (action.kind) {
    case "payment_succeeded": {
      const payment = await selectPayment(pool, action.paymentIntentId);
      if (payment === null) {
        throw new Error(`no payment for payment_intent ${action.paymentIntentId}`);
      }
      // A PaymentIntent may legitimately go failed→succeeded on a retry, so
      // 'failed' is an allowed prior; a refunded payment is never un-refunded.
      await applyGuardedTransition(pool, action.paymentIntentId, "succeeded", [
        "requires_payment",
        "processing",
        "failed",
        "succeeded",
      ]);
      // A stripe-tender POS sale issues its deferred gift-card lines now that the
      // payment is confirmed (idempotent + gated in the RPC; a no-op otherwise).
      await issueGiftCardsForPaidIntent(pool, action.paymentIntentId);
      return "succeeded";
    }
    case "payment_failed": {
      const payment = await selectPayment(pool, action.paymentIntentId);
      if (payment === null) {
        throw new Error(`no payment for payment_intent ${action.paymentIntentId}`);
      }
      // Never regress a succeeded/refunded payment to failed (out-of-order
      // delivery — the monotonic guard classifies that as a benign no-op), but a
      // repeated failure from an allowed prior is an idempotent match.
      await applyGuardedTransition(pool, action.paymentIntentId, "failed", [
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
      //
      // F1: applyGuardedTransition also catches the OTHER ordering hazard — a
      // refund that arrives BEFORE payment_intent.succeeded. The payment is then
      // still requires_payment/processing (behind the target), the guard matches
      // 0 rows, and rather than silently marking the event 'processed' (losing
      // the refund) we THROW so it retries and lands after succeeded arrives.
      const allowedPrior =
        target === "refunded"
          ? ["succeeded", "partially_refunded", "refunded"]
          : ["succeeded", "partially_refunded"];
      await applyGuardedTransition(pool, action.paymentIntentId, target, allowedPrior);
      return target;
    }
    // -- Subscriptions + dunning (unit 5.6) ---------------------------------
    // Located by the globally-unique stripe_subscription_id. A subscription we
    // do not track yet (creation is a later unit) is 'ignored', never dead-
    // lettered. The inbox is the AUTHORITY: it is the only writer that syncs a
    // subscription's status and that opens/closes a dunning cycle.
    case "subscription_updated": {
      const sub = await selectSubscriptionByStripeId(pool, action.subscriptionId);
      if (sub === null) return null;
      // F6: the Stripe event's `created` is the monotonicity clock — an older,
      // out-of-order update is applied as a benign no-op (guarded in the SQL),
      // so a delayed webhook can never regress a PAID/CANCELLED member.
      await syncSubscriptionStatus(pool, {
        sub,
        status: action.status,
        currentPeriodEnd: action.currentPeriodEnd,
        deleted: action.deleted,
        eventCreatedAt: action.eventCreatedAt,
      });
      // A Stripe-side cancellation closes any open dunning cycle (mirrored, never
      // auto-cancelled).
      if (action.deleted === true) {
        await cancelDunning(pool, { sub, now });
        return "subscription_cancelled";
      }
      return "subscription_synced";
    }
    case "invoice_payment_failed": {
      // THE dunning trigger. Stripe owns the retry cadence; opening a grace cycle
      // is idempotent across the retries' repeated failure events.
      const sub =
        action.subscriptionId === undefined
          ? null
          : await selectSubscriptionByStripeId(pool, action.subscriptionId);
      if (sub === null) return null;
      await startDunning(pool, {
        sub,
        now,
        graceWindowDays,
        detail: { invoice_id: action.invoiceId, attempt_count: action.attemptCount ?? null },
      });
      return "dunning_grace_started";
    }
    case "invoice_payment_succeeded": {
      // Recovery: a succeeded invoice closes an open cycle back to active.
      const sub =
        action.subscriptionId === undefined
          ? null
          : await selectSubscriptionByStripeId(pool, action.subscriptionId);
      if (sub === null) return null;
      await recoverDunning(pool, { sub, now });
      return "dunning_recovered";
    }
    // Truly unknown ('ignored') applies NO transition.
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
  // Undefined ⇒ startDunning resolves the grace window per-tenant (F7).
  const graceWindowDays = deps.graceWindowDays;
  const events = await claimEvents(pool, batch);
  const outcomes: InboxOutcome[] = [];

  for (const event of events) {
    const instant = now();
    try {
      const action = mapStripeEvent(event.payload);
      const transition = await applyTransition(pool, action, instant, graceWindowDays);
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
