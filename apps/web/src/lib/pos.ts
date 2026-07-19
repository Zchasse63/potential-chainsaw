import { fetchEnvelope, postEnvelope } from "./api.js";
import { inspectEnvelope } from "./envelope.js";

/**
 * The typed POS client (unit 5.8). The checkout / redeem / orders contract is
 * OWNED by the sibling unit 5.7; it is mirrored HERE so a drift against that
 * contract is a one-file change and the screen stays presentational. If those
 * routes are not yet deployed, the route's handlers surface the API error
 * through the normal DataBoundary/mutation error path — the surface never
 * fabricates a sale.
 *
 * SERVER-PRICED DISCIPLINE: a cart line is { kind, ref, qty } — a catalog id and
 * a quantity, NEVER a price. The checkout RPC re-prices every line from the
 * catalog tables at the moment of sale; any total the screen shows before that
 * is display-only and labelled as provisional.
 */

export interface CatalogRetailProduct {
  id: string;
  name: string;
  sku: string | null;
  price_cents: number;
  active: boolean;
}
export interface CatalogGiftCardProduct {
  id: string;
  name: string;
  amount_cents: number;
  active: boolean;
}
export interface CatalogDropInPlan {
  id: string;
  name: string;
  amount_cents: number;
  currency: string;
}
export interface PosCatalog {
  retail_products: CatalogRetailProduct[];
  gift_card_products: CatalogGiftCardProduct[];
  drop_in_plans: CatalogDropInPlan[];
}

export type LineKind = "retail" | "gift_card" | "drop_in";

/** A checkout line: a server-priced ref + quantity. No client price ever. */
export interface CheckoutLine {
  kind: LineKind;
  ref: string;
  qty: number;
}

export interface CheckoutRequest {
  person_id: string | null;
  lines: CheckoutLine[];
  tender: "cash";
  discount_cents?: number;
}

/** The checkout result (unit 5.7). gift_card_codes are shown ONCE and never
 *  re-fetchable — the server keeps only their hashes. */
export interface CheckoutResult {
  payment_id: string;
  order_id: string;
  gift_card_codes?: string[];
}

export interface RedeemResult {
  gift_card_id: string;
  balance_cents: number;
}

export interface PosOrder {
  id: string;
  total_cents: number;
  tender: string;
  created_at: string;
}
export interface PosOrders {
  orders: PosOrder[];
}

/** GET /pos/catalog — the server-priced picker source. */
export async function fetchCatalog(accessToken: string): Promise<unknown> {
  return fetchEnvelope("/pos/catalog", accessToken);
}

/** GET /pos/orders — recent orders (contract owned by unit 5.7). */
export async function fetchOrders(accessToken: string): Promise<unknown> {
  return fetchEnvelope("/pos/orders", accessToken);
}

/**
 * POST /pos/checkout (unit 5.7 contract). Carries an Idempotency-Key
 * (postEnvelope) and server-priced line refs only. Durable money mutation — the
 * screen reflects the sale ONLY from this confirmed response.
 */
export async function checkout(
  accessToken: string,
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  const response = await postEnvelope("/pos/checkout", accessToken, request);
  const inspection = inspectEnvelope<CheckoutResult>(response);
  if (!inspection.ok) {
    throw new Error("The checkout response was missing its provenance record; no sale is shown.");
  }
  return inspection.data;
}

/**
 * POST /pos/gift-cards/redeem (unit 5.7 contract). Exchanges a code for the new
 * balance. Idempotency-Key carried by postEnvelope.
 */
export async function redeemGiftCard(
  accessToken: string,
  code: string,
): Promise<RedeemResult> {
  const response = await postEnvelope("/pos/gift-cards/redeem", accessToken, { code });
  const inspection = inspectEnvelope<RedeemResult>(response);
  if (!inspection.ok) {
    throw new Error("The redeem response was missing its provenance record; no balance is shown.");
  }
  return inspection.data;
}
