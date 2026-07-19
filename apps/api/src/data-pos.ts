import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for the POS surface (migration 0039) — ALWAYS through the
 * user-scoped client (RLS enforced, invariant #7). The two mutations are the
 * app.pos_checkout / app.redeem_gift_card RPCs: each is a definer money RPC that
 * prices server-side and writes the ledger/outbox. Reads are ordinary member
 * SELECTs against pos_orders + pos_order_lines. Every result is Zod-validated at
 * the boundary; a shape mismatch is a server defect.
 *
 * The RPCs re-check tenancy/role in-body and RAISE typed SQLSTATEs; this layer
 * maps them onto the structured ApiError contract:
 *   42501 (insufficient_privilege) → 403   role/actor/discount re-check refused
 *   22023 (invalid_parameter_value)→ 422   pricing/tender/amount/balance violation
 *   P0002 (no_data_found)          → 404   catalog item / card / person not found
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

// -- reads: orders with their lines ------------------------------------------

export const posOrderLineSchema = z.object({
  id: uuid,
  kind: z.enum(["retail", "gift_card", "drop_in"]),
  ref_id: uuid,
  qty: z.number().int().positive(),
  unit_price_cents: z.number().int().nonnegative(),
  line_total_cents: z.number().int().nonnegative(),
  gift_card_id: uuid.nullable(),
  issued_at: timestamp.nullable(),
});

export const posOrderSchema = z.object({
  id: uuid,
  person_id: uuid.nullable(),
  payment_id: uuid.nullable(),
  subtotal_cents: z.number().int().nonnegative(),
  discount_cents: z.number().int().nonnegative(),
  tax_cents: z.number().int().nonnegative(),
  total_cents: z.number().int().nonnegative(),
  tender: z.enum(["stripe", "cash"]),
  created_at: timestamp,
  pos_order_lines: z.array(posOrderLineSchema).default([]),
});
export type PosOrderRow = z.infer<typeof posOrderSchema>;

const ORDER_COLUMNS =
  "id, person_id, payment_id, subtotal_cents, discount_cents, tax_cents, total_cents, tender, created_at, " +
  "pos_order_lines(id, kind, ref_id, qty, unit_price_cents, line_total_cents, gift_card_id, issued_at)";

/** Member-read list of the tenant's POS orders (with lines), newest first. */
export async function fetchOrders(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<PosOrderRow[]> {
  return rows(
    from(client, "pos_orders")
      .select(ORDER_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    posOrderSchema,
    "fetchOrders",
  );
}

/** Map a raised RPC SQLSTATE onto the structured error contract. */
function mapRpcError(error: QueryError, label: string): ApiError {
  switch (error.code) {
    case "42501":
      return new ApiError(403, "pos_forbidden", "database authorization denied the operation");
    case "22023":
      return new ApiError(422, "pos_invalid", error.message);
    case "P0002":
      return new ApiError(404, "pos_target_not_found", error.message);
    case "23505":
      return new ApiError(409, "idempotency_key_conflict", error.message);
    default:
      throw new Error(`${label} RPC failed: ${error.message}`);
  }
}

// -- checkout -----------------------------------------------------------------

export interface CheckoutLine {
  kind: "retail" | "gift_card" | "drop_in";
  ref_id: string;
  qty: number;
}

export interface CheckoutArgs {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  personId: string | null;
  lines: CheckoutLine[];
  tender: "cash" | "stripe";
  discountCents: number;
}

export const giftCardCodeSchema = z.object({ card_id: uuid, code: z.string().min(1) });

export const checkoutResultSchema = z.object({
  payment_id: uuid,
  order_id: uuid,
  gift_card_codes: z.array(giftCardCodeSchema).optional(),
});
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;

/**
 * Server-priced checkout. The RPC resolves every line price from the live
 * catalog, computes the total + tax in-body, records the payment (cash →
 * succeeded; stripe → requires_payment + outbox command), writes the order, and
 * for cash issues gift cards inline (raw codes returned once). Idempotent on
 * (tenant, idempotency_key). NO Stripe call happens here.
 */
export async function posCheckout(
  client: KeloSupabaseClient,
  args: CheckoutArgs,
): Promise<CheckoutResult> {
  const { data, error } = await (client as unknown as RpcClient).rpc("pos_checkout", {
    p_tenant: args.tenantId,
    p_actor: args.actorId,
    p_idempotency_key: args.idempotencyKey,
    p_person: args.personId,
    p_lines: args.lines,
    p_tender: args.tender,
    p_discount_cents: args.discountCents,
  });
  if (error !== null) throw mapRpcError(error, "posCheckout");
  return parseInternal(checkoutResultSchema, data, "posCheckout");
}

// -- gift-card redemption -----------------------------------------------------

export interface RedeemArgs {
  tenantId: string;
  actorId: string;
  code: string;
  amountCents: number;
  idempotencyKey: string;
}

export const redeemResultSchema = z.object({
  gift_card_id: uuid,
  redeemed_cents: z.number().int(),
  balance_cents: z.number().int(),
});
export type RedeemResult = z.infer<typeof redeemResultSchema>;

/**
 * Redeems a gift card by its raw code against the append-only ledger. The RPC
 * hashes the code, row-locks the active card, checks the balance, and appends a
 * negative 'redeem' entry — never mutating a balance. Over-redemption raises.
 * Idempotent on (tenant, idempotency_key).
 */
export async function redeemGiftCard(
  client: KeloSupabaseClient,
  args: RedeemArgs,
): Promise<RedeemResult> {
  const { data, error } = await (client as unknown as RpcClient).rpc("redeem_gift_card", {
    p_tenant: args.tenantId,
    p_actor: args.actorId,
    p_code: args.code,
    p_amount_cents: args.amountCents,
    p_idempotency_key: args.idempotencyKey,
  });
  if (error !== null) throw mapRpcError(error, "redeemGiftCard");
  return parseInternal(redeemResultSchema, data, "redeemGiftCard");
}
