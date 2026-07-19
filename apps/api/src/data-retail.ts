import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for retail + gift cards — ALWAYS through the user-scoped client
 * (RLS enforced, invariant #7). Catalog writes are ordinary owner/manager RLS
 * inserts; the manual gift-card grant is the app.grant_gift_card RPC (the sole
 * write path to gift_cards + the append-only ledger in phase 4). Every result
 * is Zod-validated at the boundary; a shape mismatch is a server defect.
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
  insert(values: unknown): TableBuilder;
  update(values: unknown): TableBuilder;
  delete(): TableBuilder;
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

async function rows<S extends z.ZodTypeAny>(query: TableBuilder, schema: S, label: string): Promise<z.output<S>[]> {
  const data = await run(query, label);
  return parseInternal(z.array(schema), data ?? [], label);
}

const uuid = z.string().uuid();
const timestamp = z.string().min(1);

// -- retail catalog ----------------------------------------------------------

export const retailProductSchema = z.object({
  id: uuid,
  name: z.string(),
  sku: z.string().nullable(),
  price_cents: z.number().int().nonnegative(),
  tax_category: z.string().nullable(),
  active: z.boolean(),
  created_at: timestamp,
});
export type RetailProductRow = z.infer<typeof retailProductSchema>;

const RETAIL_COLUMNS = "id, name, sku, price_cents, tax_category, active, created_at";

export async function fetchRetailProducts(client: KeloSupabaseClient, tenantId: string): Promise<RetailProductRow[]> {
  return rows(from(client, "retail_products").select(RETAIL_COLUMNS).eq("tenant_id", tenantId).order("name"), retailProductSchema, "fetchRetailProducts");
}

export async function createRetailProduct(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<RetailProductRow> {
  const row = (await rows(from(client, "retail_products").insert(input).select(RETAIL_COLUMNS), retailProductSchema, "createRetailProduct"))[0];
  if (row === undefined) throw new Error("createRetailProduct: insert returned no row");
  return row;
}

export async function updateRetailProduct(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<RetailProductRow | null> {
  return (await rows(from(client, "retail_products").update(patch).eq("tenant_id", tenantId).eq("id", id).select(RETAIL_COLUMNS), retailProductSchema, "updateRetailProduct"))[0] ?? null;
}

// -- gift-card catalog -------------------------------------------------------

export const giftCardProductSchema = z.object({
  id: uuid,
  name: z.string(),
  amount_cents: z.number().int().positive(),
  active: z.boolean(),
  created_at: timestamp,
});
export type GiftCardProductRow = z.infer<typeof giftCardProductSchema>;

const GIFT_CARD_PRODUCT_COLUMNS = "id, name, amount_cents, active, created_at";

export async function fetchGiftCardProducts(client: KeloSupabaseClient, tenantId: string): Promise<GiftCardProductRow[]> {
  return rows(from(client, "gift_card_products").select(GIFT_CARD_PRODUCT_COLUMNS).eq("tenant_id", tenantId).order("amount_cents"), giftCardProductSchema, "fetchGiftCardProducts");
}

export async function createGiftCardProduct(client: KeloSupabaseClient, input: Record<string, unknown>): Promise<GiftCardProductRow> {
  const row = (await rows(from(client, "gift_card_products").insert(input).select(GIFT_CARD_PRODUCT_COLUMNS), giftCardProductSchema, "createGiftCardProduct"))[0];
  if (row === undefined) throw new Error("createGiftCardProduct: insert returned no row");
  return row;
}

export async function updateGiftCardProduct(client: KeloSupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>): Promise<GiftCardProductRow | null> {
  return (await rows(from(client, "gift_card_products").update(patch).eq("tenant_id", tenantId).eq("id", id).select(GIFT_CARD_PRODUCT_COLUMNS), giftCardProductSchema, "updateGiftCardProduct"))[0] ?? null;
}

// -- issued gift cards + balance ---------------------------------------------
// code_hash is a SECRET and is NEVER selected into the API surface.

export const giftCardSchema = z.object({
  id: uuid,
  issued_to_person_id: uuid.nullable(),
  status: z.enum(["active", "void"]),
  created_at: timestamp,
});
export type GiftCardRow = z.infer<typeof giftCardSchema>;

export type IssuedGiftCard = GiftCardRow & { balance_cents: number };

const GIFT_CARD_COLUMNS = "id, issued_to_person_id, status, created_at";
const ledgerAmountSchema = z.object({ gift_card_id: uuid, amount_cents: z.number().int() });

/**
 * Issued cards with their derived balance. Balance is the sum of the
 * append-only ledger (invariant #6) — computed here from the ledger rows so it
 * is unit-testable without a live DB; the same sum is exposed SQL-side by
 * public.gift_card_balance for phase-5 redemption.
 */
export async function fetchGiftCards(client: KeloSupabaseClient, tenantId: string): Promise<IssuedGiftCard[]> {
  const [cards, ledger] = await Promise.all([
    rows(from(client, "gift_cards").select(GIFT_CARD_COLUMNS).eq("tenant_id", tenantId).order("created_at", { ascending: false }), giftCardSchema, "fetchGiftCards"),
    rows(from(client, "gift_card_ledger").select("gift_card_id, amount_cents").eq("tenant_id", tenantId), ledgerAmountSchema, "fetchGiftCardLedger"),
  ]);
  return withBalances(cards, ledger);
}

/** Pure balance fold (exported for direct unit tests): balance = sum(ledger). */
export function withBalances(
  cards: readonly GiftCardRow[],
  ledger: readonly { gift_card_id: string; amount_cents: number }[],
): IssuedGiftCard[] {
  const balances = new Map<string, number>();
  for (const entry of ledger) {
    balances.set(entry.gift_card_id, (balances.get(entry.gift_card_id) ?? 0) + entry.amount_cents);
  }
  return cards.map((card) => ({ ...card, balance_cents: balances.get(card.id) ?? 0 }));
}

/**
 * The MANUAL (comp) grant. The route generates the raw code and passes ONLY
 * its hash — this layer never sees or accepts a raw code. Returns the new card
 * id. A 42501 from the RPC is the DB re-check refusing the write → 403.
 */
export async function grantGiftCard(
  client: KeloSupabaseClient,
  args: { tenantId: string; amountCents: number; codeHash: string; personId: string | null; actorId: string; reason: string | null },
): Promise<string> {
  const { data, error } = await (client as unknown as RpcClient).rpc("grant_gift_card", {
    p_tenant: args.tenantId,
    p_amount_cents: args.amountCents,
    p_code_hash: args.codeHash,
    p_person: args.personId,
    p_actor: args.actorId,
    p_reason: args.reason,
  });
  if (error !== null) {
    if (error.code === "42501") {
      throw new ApiError(403, "gift_card_grant_forbidden", "database authorization denied the gift-card grant");
    }
    throw new Error(`grant_gift_card RPC failed: ${error.message}`);
  }
  return parseInternal(uuid, data, "grantGiftCard");
}
