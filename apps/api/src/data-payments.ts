import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for the money-intent surface (migration 0034) — ALWAYS through
 * the user-scoped client (RLS enforced, invariant #7). The two mutations are the
 * app.create_payment_intent / app.create_refund RPCs: each WRITES an outbox
 * command (never calls Stripe) and returns an id. Reads are ordinary member
 * SELECTs against public.payments. Every result is Zod-validated at the
 * boundary; a shape mismatch is a server defect.
 *
 * The RPC re-checks tenancy/role in-body and RAISEs typed SQLSTATEs; this layer
 * maps them onto the structured ApiError contract:
 *   42501 (insufficient_privilege) → 403   role/actor re-check refused the write
 *   22023 (invalid_parameter_value)→ 422   amount/currency/refundable violation
 *   P0002 (no_data_found)          → 404   customer/payment not found for tenant
 *   23505 (unique_violation)       → 409   key already used for another operation
 */

interface QueryError {
  message: string;
  code?: string;
}
interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

async function run(query: PromiseLike<QueryResult>, label: string): Promise<unknown> {
  const { data, error } = await query;
  if (error !== null) throw new Error(`${label} query failed: ${error.message}`);
  return data;
}

function parseInternal<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  return parsed.data;
}

async function rows<S extends z.ZodTypeAny>(
  query: TableBuilder,
  schema: S,
  label: string,
): Promise<z.output<S>[]> {
  const data = await run(query, label);
  return parseInternal(z.array(schema), data ?? [], label);
}

const uuid = z.string().uuid();
const timestamp = z.string().min(1);

export const paymentStatusSchema = z.enum([
  "requires_payment",
  "processing",
  "succeeded",
  "failed",
  "refunded",
  "partially_refunded",
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const paymentSchema = z.object({
  id: uuid,
  customer_id: uuid.nullable(),
  amount_cents: z.number().int().nonnegative(),
  currency: z.string(),
  status: paymentStatusSchema,
  stripe_payment_intent_id: z.string().nullable(),
  command_id: uuid.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type PaymentRow = z.infer<typeof paymentSchema>;

const PAYMENT_COLUMNS =
  "id, customer_id, amount_cents, currency, status, stripe_payment_intent_id, command_id, created_at, updated_at";

/** Member-read list of the tenant's payments, newest first (RLS-scoped). */
export async function fetchPayments(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<PaymentRow[]> {
  return rows(
    from(client, "payments")
      .select(PAYMENT_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    paymentSchema,
    "fetchPayments",
  );
}

/** A single payment by id, tenant-scoped; null if it is not this tenant's. */
export async function fetchPayment(
  client: KeloSupabaseClient,
  tenantId: string,
  id: string,
): Promise<PaymentRow | null> {
  return (
    (
      await rows(
        from(client, "payments").select(PAYMENT_COLUMNS).eq("tenant_id", tenantId).eq("id", id),
        paymentSchema,
        "fetchPayment",
      )
    )[0] ?? null
  );
}

/** Map a raised RPC SQLSTATE onto the structured error contract. */
function mapRpcError(error: QueryError, label: string): ApiError {
  switch (error.code) {
    case "42501":
      return new ApiError(403, "payment_forbidden", "database authorization denied the operation");
    case "22023":
      return new ApiError(422, "payment_invalid", error.message);
    case "P0002":
      return new ApiError(404, "payment_target_not_found", error.message);
    case "23505":
      return new ApiError(409, "idempotency_key_conflict", error.message);
    default:
      throw new Error(`${label} RPC failed: ${error.message}`);
  }
}

export interface CreatePaymentIntentArgs {
  tenantId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  actorId: string;
}

/**
 * Records the intent to charge. The RPC writes a payments row + a linked
 * create_payment_intent outbox command in one transaction and returns the
 * payment id. Idempotent on (tenant, idempotency_key): a replay returns the same
 * payment id and never writes a second command. NO Stripe call happens here.
 */
export async function createPaymentIntent(
  client: KeloSupabaseClient,
  args: CreatePaymentIntentArgs,
): Promise<string> {
  const { data, error } = await (client as unknown as RpcClient).rpc("create_payment_intent", {
    p_tenant: args.tenantId,
    p_customer: args.customerId,
    p_amount_cents: args.amountCents,
    p_currency: args.currency,
    p_idempotency_key: args.idempotencyKey,
    p_actor: args.actorId,
  });
  if (error !== null) throw mapRpcError(error, "createPaymentIntent");
  return parseInternal(uuid, data, "createPaymentIntent");
}

export interface CreateRefundArgs {
  tenantId: string;
  paymentId: string;
  amountCents: number;
  idempotencyKey: string;
  actorId: string;
  reason: string | null;
}

/**
 * Records the intent to refund a succeeded payment. The RPC writes a
 * create_refund outbox command (pending) and returns its id; it NEVER flips the
 * payment status (the webhook is the authority). Idempotent on (tenant,
 * idempotency_key). NO Stripe call happens here.
 */
export async function createRefund(
  client: KeloSupabaseClient,
  args: CreateRefundArgs,
): Promise<string> {
  const { data, error } = await (client as unknown as RpcClient).rpc("create_refund", {
    p_tenant: args.tenantId,
    p_payment: args.paymentId,
    p_amount_cents: args.amountCents,
    p_idempotency_key: args.idempotencyKey,
    p_actor: args.actorId,
    p_reason: args.reason,
  });
  if (error !== null) throw mapRpcError(error, "createRefund");
  return parseInternal(uuid, data, "createRefund");
}
