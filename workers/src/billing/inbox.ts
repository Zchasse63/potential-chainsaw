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

export interface InboxDeps {
  /** Injectable clock (processed_at). Defaults to now; never Date.now in-body. */
  readonly now?: () => Date;
  /** Max events claimed per run. */
  readonly batch?: number;
}

/** How one event was resolved — returned for tests and processor logging. */
export interface InboxOutcome {
  readonly eventId: string;
  readonly status: "processed" | "ignored" | "error";
  /** The money transition applied (present only when a payment was touched). */
  readonly transition?: string;
}

interface ClaimedEvent {
  readonly id: string;
  readonly eventId: string;
  readonly payload: unknown;
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
    `select id, event_id, payload
     from public.stripe_events
     where status = 'received'
     order by received_at asc
     limit $1`,
    [batch],
  );
  const events: ClaimedEvent[] = [];
  for (const row of result.rows) {
    const parsed = row as { id?: unknown; event_id?: unknown; payload?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.event_id !== "string") continue;
    events.push({ id: parsed.id, eventId: parsed.event_id, payload: parsed.payload });
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
      // A refund only applies to a captured (succeeded) payment; a further
      // refund on an already-refunded payment stays idempotent.
      await setPaymentStatus(pool, action.paymentIntentId, target, [
        "succeeded",
        "partially_refunded",
        "refunded",
      ]);
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
 * Drain the stripe_events inbox. NEVER throws for a per-event failure — the
 * 'error' row IS the failure surface (one bad event must not blind the others).
 */
export async function runInbox(
  pool: PooledQueryable,
  deps: InboxDeps = {},
): Promise<InboxOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? DEFAULT_BATCH;
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
      await markEvent(pool, event.id, "error", message, instant);
      outcomes.push({ eventId: event.eventId, status: "error" });
    }
  }

  return outcomes;
}
