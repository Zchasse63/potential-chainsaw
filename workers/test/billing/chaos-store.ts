import type { PooledQueryable } from "../../src/glofox/types.js";

/**
 * THE CHAOS HARNESS STORE (Phase 5 · unit 5.5) — a STATEFUL in-memory
 * payments/commands/events store that answers the EXACT SQL the real inbox
 * (src/billing/inbox.ts) and outbox (src/billing/outbox.ts) processors issue,
 * so the chaos test can fire adversarial event schedules at the REAL processor
 * code with no DB and no network. It is deliberately a faithful mock of the
 * spine's behaviour, NOT a general SQL engine: it matches each processor query
 * by its distinctive fragment and mutates the in-memory rows the same way
 * Postgres would.
 *
 * Two behaviours matter for the invariants under test:
 *   - deliverEvent() models the WEBHOOK RECEIVER's insert, including the
 *     unique(event_id) dedupe: redelivering an event_id already present is a
 *     no-op (the duplicate never enters the inbox) — that is what makes the
 *     dupe/replay scenarios net-identical.
 *   - the payments UPDATE honours the processor's `status = any($allowed)` guard
 *     verbatim, so the inbox's MONOTONIC refund guard ('refunded' is terminal)
 *     is exercised for real, not re-implemented.
 *
 * received_at is an injected monotonic counter (NO wall clock): the test sets
 * delivery order by the order it calls deliverEvent, and the inbox claim sorts
 * by it, exactly as `order by received_at asc` would.
 */

export interface PaymentRow {
  id: string;
  tenant_id: string;
  command_id: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number;
  status: string;
}

export interface CommandRow {
  id: string;
  tenant_id: string;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  stripe_object_id: string | null;
  last_error: string | null;
  seq: number;
}

export interface EventRow {
  id: string;
  event_id: string;
  payload: unknown;
  attempts: number;
  stripe_account_id: string | null;
  status: string;
  received_at: number;
  processed_at: string | null;
  error: string | null;
}

export interface AlertRow {
  tenant_id: string | null;
  kind: string;
  values: readonly unknown[];
}

export interface DeliverEventInput {
  readonly id: string;
  readonly eventId: string;
  readonly payload: unknown;
  readonly accountId?: string | null;
}

type Row = Record<string, unknown>;

function includesAll(text: string, ...needles: string[]): boolean {
  return needles.every((n) => text.includes(n));
}

export class ChaosStore implements PooledQueryable {
  readonly payments: PaymentRow[] = [];
  readonly commands: CommandRow[] = [];
  readonly events: EventRow[] = [];
  readonly alerts: AlertRow[] = [];

  #receivedSeq = 0;
  #commandSeq = 0;

  // --- seeding (the test builds the world; the processors never insert) --------

  addAccount(_tenantId: string, _stripeAccountId: string): void {
    // Accounts live only in #accounts; kept as a map on the instance.
    this.#accounts.set(_tenantId, _stripeAccountId);
  }

  readonly #accounts = new Map<string, string>();

  addPayment(row: {
    id: string;
    tenantId: string;
    commandId?: string | null;
    intentId?: string | null;
    amountCents: number;
    status: string;
  }): void {
    this.payments.push({
      id: row.id,
      tenant_id: row.tenantId,
      command_id: row.commandId ?? null,
      stripe_payment_intent_id: row.intentId ?? null,
      amount_cents: row.amountCents,
      status: row.status,
    });
  }

  addCommand(row: {
    id: string;
    tenantId: string;
    kind: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    status?: string;
    attempts?: number;
  }): void {
    this.#commandSeq += 1;
    this.commands.push({
      id: row.id,
      tenant_id: row.tenantId,
      kind: row.kind,
      idempotency_key: row.idempotencyKey,
      payload: row.payload,
      status: row.status ?? "pending",
      attempts: row.attempts ?? 0,
      stripe_object_id: null,
      last_error: null,
      seq: this.#commandSeq,
    });
  }

  /**
   * Model the webhook receiver's durable insert WITH the unique(event_id)
   * dedupe: a redelivered event_id is dropped. Returns true if it entered the
   * inbox, false if it was a duplicate.
   */
  deliverEvent(input: DeliverEventInput): boolean {
    if (this.events.some((e) => e.event_id === input.eventId)) return false;
    this.#receivedSeq += 1;
    this.events.push({
      id: input.id,
      event_id: input.eventId,
      payload: input.payload,
      attempts: 0,
      stripe_account_id: input.accountId ?? null,
      status: "received",
      received_at: this.#receivedSeq,
      processed_at: null,
      error: null,
    });
    return true;
  }

  // --- inspection (the test asserts the FINAL state) ---------------------------

  paymentByIntent(intentId: string): PaymentRow | undefined {
    return this.payments.find((p) => p.stripe_payment_intent_id === intentId);
  }

  paymentById(id: string): PaymentRow | undefined {
    return this.payments.find((p) => p.id === id);
  }

  eventByEventId(eventId: string): EventRow | undefined {
    return this.events.find((e) => e.event_id === eventId);
  }

  // --- the query dispatcher (answers the processors' exact SQL) ----------------

  query = async (text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }> => {
    const v = values ?? [];
    const trimmed = text.trim();

    // Transaction control (the outbox's withTransaction runs these on the pool
    // itself, since this store has no connect()).
    if (trimmed === "begin" || trimmed === "commit" || trimmed === "rollback") {
      return { rows: [] };
    }

    // --- SELECTs -------------------------------------------------------------
    // Inbox claim: received events, oldest first, limited to the batch.
    if (includesAll(text, "from public.stripe_events", "where status = 'received'", "order by received_at")) {
      const batch = Number(v[0] ?? 50);
      const rows: Row[] = this.events
        .filter((e) => e.status === "received")
        .sort((a, b) => a.received_at - b.received_at)
        .slice(0, batch)
        .map((e) => ({
          id: e.id,
          event_id: e.event_id,
          payload: e.payload,
          attempts: e.attempts,
          stripe_account_id: e.stripe_account_id,
        }));
      return { rows };
    }

    // Inbox selectPayment by intent id.
    if (text.includes("select status, amount_cents from public.payments")) {
      const p = this.paymentByIntent(String(v[0]));
      return { rows: p ? [{ status: p.status, amount_cents: p.amount_cents }] : [] };
    }

    // Outbox claim: pending commands, oldest first, FOR UPDATE SKIP LOCKED.
    if (includesAll(text, "from public.stripe_commands", "for update skip locked")) {
      const batch = Number(v[0] ?? 25);
      const rows: Row[] = this.commands
        .filter((c) => c.status === "pending")
        .sort((a, b) => a.seq - b.seq)
        .slice(0, batch)
        .map((c) => ({
          id: c.id,
          tenant_id: c.tenant_id,
          kind: c.kind,
          idempotency_key: c.idempotency_key,
          payload: c.payload,
          attempts: c.attempts,
        }));
      return { rows };
    }

    // Outbox resolve connected account.
    if (text.includes("select stripe_account_id from public.stripe_accounts")) {
      const account = this.#accounts.get(String(v[0]));
      return { rows: account === undefined ? [] : [{ stripe_account_id: account }] };
    }

    // --- UPDATEs -------------------------------------------------------------
    // Inbox setPaymentStatus: guarded transition (status = any($allowed)).
    if (includesAll(text, "update public.payments", "set status = $1", "stripe_payment_intent_id = $2")) {
      const [target, intentId, allowed] = v as [string, string, readonly string[]];
      const p = this.paymentByIntent(intentId);
      if (p && allowed.includes(p.status)) p.status = target;
      return { rows: [] };
    }

    // Outbox link: stamp the intent id onto the RPC-created payment.
    if (includesAll(text, "update public.payments", "set stripe_payment_intent_id = $1")) {
      const [objectId, tenantId, commandId] = v as [string, string, string];
      const p = this.payments.find(
        (row) =>
          row.tenant_id === tenantId &&
          row.command_id === commandId &&
          row.stripe_payment_intent_id === null,
      );
      if (p) p.stripe_payment_intent_id = objectId;
      return { rows: [] };
    }

    // Inbox markEvent: terminal processed/ignored/error with processed_at.
    if (includesAll(text, "update public.stripe_events", "set status = $1, processed_at = $2, error = $3")) {
      const [status, processedAt, error, id] = v as [string, string, string | null, string];
      const e = this.events.find((row) => row.id === id);
      if (e) {
        e.status = status;
        e.processed_at = processedAt;
        e.error = error;
      }
      return { rows: [] };
    }

    // Inbox retry: bump attempts, keep 'received'.
    if (includesAll(text, "update public.stripe_events", "set attempts = $1, error = $2", "status = 'received'")) {
      const [attempts, error, id] = v as [number, string, string];
      const e = this.events.find((row) => row.id === id && row.status === "received");
      if (e) {
        e.attempts = attempts;
        e.error = error;
      }
      return { rows: [] };
    }

    // Inbox dead-letter: terminal 'error' after max attempts.
    if (includesAll(text, "update public.stripe_events", "set status = 'error', attempts = $1")) {
      const [attempts, error, processedAt, id] = v as [number, string, string, string];
      const e = this.events.find((row) => row.id === id);
      if (e) {
        e.status = "error";
        e.attempts = attempts;
        e.error = error;
        e.processed_at = processedAt;
      }
      return { rows: [] };
    }

    // Outbox markSent: command pending→sent + object id.
    if (includesAll(text, "update public.stripe_commands", "set status = 'sent'")) {
      const [objectId, id, tenantId] = v as [string, string, string];
      const c = this.commands.find((row) => row.id === id && row.tenant_id === tenantId);
      if (c) {
        c.status = "sent";
        c.stripe_object_id = objectId;
        c.last_error = null;
      }
      return { rows: [] };
    }

    // Outbox dead-letter: command → 'failed'.
    if (includesAll(text, "update public.stripe_commands", "set status = 'failed'")) {
      const [attempts, error, id, tenantId] = v as [number, string, string, string];
      const c = this.commands.find((row) => row.id === id && row.tenant_id === tenantId);
      if (c) {
        c.status = "failed";
        c.attempts = attempts;
        c.last_error = error;
      }
      return { rows: [] };
    }

    // Outbox retry: bump attempts, keep 'pending'.
    if (includesAll(text, "update public.stripe_commands", "set attempts = $1, last_error = $2")) {
      const [attempts, error, id, tenantId] = v as [number, string, string, string];
      const c = this.commands.find(
        (row) => row.id === id && row.tenant_id === tenantId && row.status === "pending",
      );
      if (c) {
        c.attempts = attempts;
        c.last_error = error;
      }
      return { rows: [] };
    }

    // --- INSERTs -------------------------------------------------------------
    // Alerts (inbox + outbox dead-letter). Record for inspection; the harness
    // scenarios don't dead-letter, but a stray alert would be visible here.
    if (text.includes("insert into public.alerts")) {
      this.alerts.push({
        tenant_id: typeof v[0] === "string" ? v[0] : null,
        kind: "alert",
        values: v,
      });
      return { rows: [] };
    }

    throw new Error(`ChaosStore: unrecognized query: ${text.slice(0, 120)}`);
  };
}
