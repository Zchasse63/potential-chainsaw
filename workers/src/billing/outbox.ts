import { StripeClient, stripeConfigFromEnv, type Env, type StripeObjectResult } from "@kelo/stripe";
import { withTransaction } from "../glofox/pipeline.js";
import type { Queryable } from "../processors.js";
import type { PooledQueryable } from "../glofox/types.js";

/**
 * Phase 5 · unit 5.3 — THE STRIPE OUTBOX PROCESSOR (the durable delivery engine;
 * plan-final §5, threat-model §6). The crash-safety spine: a money RPC (unit
 * 5.4) INSERTS a stripe_commands row (status 'pending') with its idempotency_key
 * BEFORE any API call, and THIS processor is the at-least-once delivery — it
 * drives pending commands to Stripe and NEVER creates one.
 *
 * Per command:
 *   - claim FOR UPDATE SKIP LOCKED (like the jobs queue) so two concurrent ticks
 *     never drive the same command;
 *   - call the @kelo/stripe adapter method for command.kind, passing the
 *     command's OWN idempotency_key — so a retried Stripe call is deduped by
 *     Stripe (the key is the safety net; a redelivery is never a double charge);
 *   - on success: status→'sent' + stripe_object_id, and (for a payment_intent)
 *     link the intent id onto the payment the RPC created;
 *   - on failure: attempts++ + last_error, stay 'pending' for retry — until
 *     maxAttempts, at which point status→'failed' + a critical alert.
 *
 * The adapter runs DRY-RUN with no STRIPE_SECRET_KEY (no Connect account exists
 * yet — BLOCKERS P0-5), returning a synthetic id and making NO network call, so
 * the whole delivery pipeline is exercisable now. Scoped per connected account
 * (stripe_accounts.stripe_account_id) from the first line.
 */

export const BILLING_PROCESS_OUTBOX_KIND = "stripe.process_outbox";

/** Default commands drained per run. */
const DEFAULT_BATCH = 25;
/** Delivery attempts before a command is dead-lettered (status 'failed'). */
const DEFAULT_MAX_ATTEMPTS = 5;

/** The adapter surface the outbox drives — exactly @kelo/stripe's create calls. */
export type StripeAdapter = Pick<
  StripeClient,
  "createPaymentIntent" | "createRefund" | "createCustomer" | "createSubscription" | "createPrice"
>;

export interface OutboxDeps {
  /**
   * Build the adapter for a connected account. Production default constructs a
   * real StripeClient from env (dry-run without a key). Tests inject a double.
   */
  readonly makeClient?: (opts: { stripeAccountId: string }) => StripeAdapter;
  /** Env the default client reads STRIPE_SECRET_KEY from (by name; never logged). */
  readonly env?: Env;
  readonly batch?: number;
  readonly maxAttempts?: number;
}

/** How one command ended — returned for tests and processor logging. */
export interface OutboxOutcome {
  readonly commandId: string;
  readonly status: "sent" | "pending" | "failed";
  readonly attempts?: number;
  readonly stripeObjectId?: string;
}

interface ClaimedCommand {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requireStr(value: unknown, field: string): string {
  const s = str(value);
  if (s === undefined) throw new Error(`stripe command payload is missing required "${field}"`);
  return s;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireNum(value: unknown, field: string): number {
  const n = num(value);
  if (n === undefined) throw new Error(`stripe command payload is missing required "${field}"`);
  return n;
}

function parseItems(value: unknown): { price: string; quantity?: number }[] {
  if (!Array.isArray(value)) throw new Error(`stripe command payload "items" must be an array`);
  return value.map((raw) => {
    const item = asRecord(raw);
    return { price: requireStr(item["price"], "items[].price"), quantity: num(item["quantity"]) };
  });
}

function parseRecurring(
  value: unknown,
): { interval: "day" | "week" | "month" | "year"; intervalCount?: number } | undefined {
  if (value === undefined || value === null) return undefined;
  const rec = asRecord(value);
  const interval = requireStr(rec["interval"], "recurring.interval");
  if (interval !== "day" && interval !== "week" && interval !== "month" && interval !== "year") {
    throw new Error(`stripe command payload "recurring.interval" is invalid: ${interval}`);
  }
  return { interval, intervalCount: num(rec["interval_count"]) };
}

/** Dispatch the claimed command to its adapter method, ALWAYS forwarding the
 * command's own idempotency key (never a fresh one — the key is what makes a
 * retried call safe). An unknown kind is loud (throws → attempts/last_error). */
async function dispatch(client: StripeAdapter, cmd: ClaimedCommand): Promise<StripeObjectResult> {
  const p = cmd.payload;
  switch (cmd.kind) {
    case "payment_intent":
      return client.createPaymentIntent({
        amount: requireNum(p["amount"], "amount"),
        currency: requireStr(p["currency"], "currency"),
        customer: str(p["customer"]),
        idempotencyKey: cmd.idempotencyKey,
      });
    case "refund":
      return client.createRefund({
        paymentIntent: requireStr(p["payment_intent"], "payment_intent"),
        amount: num(p["amount"]),
        idempotencyKey: cmd.idempotencyKey,
      });
    case "customer":
      return client.createCustomer({
        email: str(p["email"]),
        name: str(p["name"]),
        idempotencyKey: cmd.idempotencyKey,
      });
    case "subscription":
      return client.createSubscription({
        customer: requireStr(p["customer"], "customer"),
        items: parseItems(p["items"]),
        idempotencyKey: cmd.idempotencyKey,
      });
    case "price":
      return client.createPrice({
        currency: requireStr(p["currency"], "currency"),
        unitAmount: requireNum(p["unit_amount"], "unit_amount"),
        product: str(p["product"]),
        recurring: parseRecurring(p["recurring"]),
        idempotencyKey: cmd.idempotencyKey,
      });
    default:
      throw new Error(`unknown stripe command kind: ${cmd.kind}`);
  }
}

async function claimCommands(pool: Queryable, batch: number): Promise<ClaimedCommand[]> {
  const result = await pool.query(
    `select id, tenant_id, kind, idempotency_key, payload, attempts
     from public.stripe_commands
     where status = 'pending'
     order by created_at asc
     limit $1
     for update skip locked`,
    [batch],
  );
  const commands: ClaimedCommand[] = [];
  for (const row of result.rows) {
    const parsed = row as {
      id?: unknown;
      tenant_id?: unknown;
      kind?: unknown;
      idempotency_key?: unknown;
      payload?: unknown;
      attempts?: unknown;
    };
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.tenant_id !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.idempotency_key !== "string"
    ) {
      continue;
    }
    commands.push({
      id: parsed.id,
      tenantId: parsed.tenant_id,
      kind: parsed.kind,
      idempotencyKey: parsed.idempotency_key,
      payload: asRecord(parsed.payload),
      attempts: num(parsed.attempts) ?? 0,
    });
  }
  return commands;
}

async function resolveStripeAccount(tx: Queryable, tenantId: string): Promise<string | undefined> {
  const result = await tx.query(
    `select stripe_account_id from public.stripe_accounts where tenant_id = $1`,
    [tenantId],
  );
  return str(asRecord(result.rows[0])["stripe_account_id"]);
}

async function markSent(
  tx: Queryable,
  cmd: ClaimedCommand,
  result: StripeObjectResult,
): Promise<void> {
  await tx.query(
    `update public.stripe_commands
     set status = 'sent', stripe_object_id = $1, last_error = null
     where id = $2 and tenant_id = $3`,
    [result.id, cmd.id, cmd.tenantId],
  );
  // Link the created object back onto the payment the RPC opened for this
  // command (the webhook later flips its money state by this intent id).
  if (cmd.kind === "payment_intent") {
    await tx.query(
      `update public.payments
       set stripe_payment_intent_id = $1
       where tenant_id = $2 and command_id = $3 and stripe_payment_intent_id is null`,
      [result.id, cmd.tenantId, cmd.id],
    );
  }
}

async function markFailure(
  tx: Queryable,
  cmd: ClaimedCommand,
  message: string,
  maxAttempts: number,
): Promise<OutboxOutcome> {
  const attempts = cmd.attempts + 1;
  if (attempts >= maxAttempts) {
    await tx.query(
      `update public.stripe_commands
       set status = 'failed', attempts = $1, last_error = $2
       where id = $3 and tenant_id = $4`,
      [attempts, message, cmd.id, cmd.tenantId],
    );
    // Dead-letter: a command that exhausted its retries stops the money flow —
    // surface it loudly (deduped per command via the open-alert partial index).
    await tx.query(
      `insert into public.alerts (tenant_id, kind, severity, title, body, dedupe_key, context)
       values ($1, 'stripe_command_failed', 'critical', $2, $3, $4, $5)
       on conflict (tenant_id, kind, dedupe_key) where status = 'open' do nothing`,
      [
        cmd.tenantId,
        `Stripe ${cmd.kind} command dead-lettered after ${attempts} attempts`,
        message,
        cmd.id,
        JSON.stringify({ command_id: cmd.id, kind: cmd.kind }),
      ],
    );
    return { commandId: cmd.id, status: "failed", attempts };
  }
  // Stay 'pending' for the next tick; the SAME idempotency_key retries safely.
  await tx.query(
    `update public.stripe_commands
     set attempts = $1, last_error = $2
     where id = $3 and tenant_id = $4 and status = 'pending'`,
    [attempts, message, cmd.id, cmd.tenantId],
  );
  return { commandId: cmd.id, status: "pending", attempts };
}

/**
 * Drive every pending command to Stripe. Per-command errors are ISOLATED (a
 * failing command records attempts/last_error and the loop continues); a throw
 * escapes only if a DB write itself fails, rolling back the batch for the job
 * layer to retry.
 */
export async function runOutbox(
  pool: PooledQueryable,
  deps: OutboxDeps = {},
): Promise<OutboxOutcome[]> {
  const batch = deps.batch ?? DEFAULT_BATCH;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const makeClient =
    deps.makeClient ??
    ((opts: { stripeAccountId: string }) =>
      new StripeClient(stripeConfigFromEnv(opts.stripeAccountId, deps.env ?? process.env)));

  const outcomes: OutboxOutcome[] = [];

  await withTransaction(pool, async (tx) => {
    const claimed = await claimCommands(tx, batch);
    for (const cmd of claimed) {
      try {
        const stripeAccountId = await resolveStripeAccount(tx, cmd.tenantId);
        if (stripeAccountId === undefined) {
          throw new Error(`no connected Stripe account for tenant ${cmd.tenantId}`);
        }
        const client = makeClient({ stripeAccountId });
        const result = await dispatch(client, cmd);
        await markSent(tx, cmd, result);
        outcomes.push({ commandId: cmd.id, status: "sent", stripeObjectId: result.id });
      } catch (err) {
        const message = (err instanceof Error ? err.message : "unknown outbox error").slice(
          0,
          1_000,
        );
        outcomes.push(await markFailure(tx, cmd, message, maxAttempts));
      }
    }
  });

  return outcomes;
}
