import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";

/**
 * Data access for the POS catalog surface (unit 5.8) — the read the cash
 * checkout screen prices its picker against. ALWAYS through the user-scoped
 * client (RLS enforced, invariant #7). SERVER-PRICED ONLY: the browser never
 * sends a price; it sends a line ref + kind + qty and the checkout RPC (unit
 * 5.7) re-prices from these same tables at the moment of sale. Every row is
 * Zod-validated at the boundary; a shape mismatch is a server defect.
 *
 * Drop-in plans are the `plans` rows whose kelo_type is 'drop_in'; their price
 * is the CURRENT (non-superseded) one-time phase in the append-only
 * plan_prices history (invariant #6 — prices are immutable phases, never a
 * mutable column). A drop-in without a current price is not sellable and is
 * omitted from the catalog.
 */

interface QueryError {
  message: string;
}
interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  is(column: string, value: unknown): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

async function run(query: PromiseLike<QueryResult>, label: string): Promise<unknown> {
  const { data, error } = await query;
  if (error !== null) throw new Error(`${label} query failed: ${error.message}`);
  return data;
}

function parseRows<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S>[] {
  const parsed = z.array(schema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  }
  return parsed.data;
}

const uuid = z.string().uuid();

const planRowSchema = z.object({ id: uuid, name: z.string() });
const priceRowSchema = z.object({
  plan_id: uuid,
  amount_cents: z.number().int().nonnegative(),
  currency: z.string(),
  effective_from: z.string(),
});

export const dropInPlanSchema = z.object({
  id: uuid,
  name: z.string(),
  amount_cents: z.number().int().nonnegative(),
  currency: z.string(),
});
export type DropInPlan = z.infer<typeof dropInPlanSchema>;

/**
 * Sellable drop-in plans with their current one-time price (RLS-scoped). A
 * plan with no current (non-superseded) price is omitted — you cannot ring up
 * an unpriced line. When a plan somehow has more than one live phase, the most
 * recently effective one wins.
 */
export async function fetchDropInPlans(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<DropInPlan[]> {
  const plans = parseRows(
    planRowSchema,
    await run(
      from(client, "plans")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .eq("kelo_type", "drop_in")
        .eq("active", true)
        .order("name"),
      "fetchDropInPlans.plans",
    ),
    "fetchDropInPlans.plans",
  );
  if (plans.length === 0) return [];

  const prices = parseRows(
    priceRowSchema,
    await run(
      from(client, "plan_prices")
        .select("plan_id, amount_cents, currency, effective_from")
        .eq("tenant_id", tenantId)
        .is("superseded_at", null)
        .order("effective_from", { ascending: false }),
      "fetchDropInPlans.prices",
    ),
    "fetchDropInPlans.prices",
  );

  // First price per plan wins (rows arrive newest-effective first).
  const currentByPlan = new Map<string, z.infer<typeof priceRowSchema>>();
  for (const price of prices) {
    if (!currentByPlan.has(price.plan_id)) currentByPlan.set(price.plan_id, price);
  }

  const catalog: DropInPlan[] = [];
  for (const plan of plans) {
    const price = currentByPlan.get(plan.id);
    if (price === undefined) continue;
    catalog.push({
      id: plan.id,
      name: plan.name,
      amount_cents: price.amount_cents,
      currency: price.currency,
    });
  }
  return catalog;
}
