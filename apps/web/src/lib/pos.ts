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
 * SERVER-PRICED DISCIPLINE: a cart line is { kind, ref_id, qty } — a catalog id
 * and a quantity, NEVER a price. The checkout RPC re-prices every line from the
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

/** How a POS sale is settled at the till. The API also accepts 'stripe', but the
 *  cash-day POS surface only offers over-the-counter tenders. */
export type PosTender = "cash" | "gift_card";

/** A checkout line: a server-priced ref_id + quantity. No client price ever.
 *  The field name mirrors the API zod schema (checkoutLine.ref_id, uuid). */
export interface CheckoutLine {
  kind: LineKind;
  ref_id: string;
  qty: number;
}

export interface CheckoutRequest {
  person_id: string | null;
  lines: CheckoutLine[];
  tender: PosTender;
  /** Required for tender='gift_card': the raw settlement card code (hashed
   *  server-side; the server settles + raises on over-redemption). */
  gift_card_code?: string;
  discount_cents?: number;
}

/** One issued gift card in a checkout result (mirrors the API
 *  giftCardCodeSchema: { card_id, code }). Shown ONCE and never re-fetchable —
 *  the server keeps only the hash. */
export interface GiftCardCode {
  card_id: string;
  code: string;
}

/** The checkout result (unit 5.7 contract): { payment_id, order_id,
 *  gift_card_codes? }. */
export interface CheckoutResult {
  payment_id: string;
  order_id: string;
  gift_card_codes?: GiftCardCode[];
}

/** The redeem result (unit 5.7 contract): { gift_card_id, redeemed_cents,
 *  balance_cents }. */
export interface RedeemResult {
  gift_card_id: string;
  redeemed_cents: number;
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
 * POST /pos/checkout (unit 5.7 contract). Server-priced line refs only. Durable
 * money mutation — the screen reflects the sale ONLY from this confirmed
 * response. `idempotencyKey` is the ONE key for this checkout intent, reused
 * across retries so a timeout-after-commit + retry cannot ring a second sale.
 */
export async function checkout(
  accessToken: string,
  request: CheckoutRequest,
  idempotencyKey: string,
): Promise<CheckoutResult> {
  const response = await postEnvelope(
    "/pos/checkout",
    accessToken,
    request,
    undefined,
    idempotencyKey,
  );
  const inspection = inspectEnvelope<{ checkout: CheckoutResult }>(response);
  if (!inspection.ok) {
    throw new Error("The checkout response was missing its provenance record; no sale is shown.");
  }
  // The route nests the result (c.var.ok({ checkout })) — unwrap it, mirroring
  // requestRefund's `.refund` convention. Re-review blocker B1: returning the
  // envelope data verbatim rendered 'Order undefined' and silently DROPPED the
  // one-time gift-card codes (unrecoverable — the server stores only hashes).
  return inspection.data.checkout;
}

/**
 * POST /pos/gift-cards/redeem (unit 5.7 contract). Posts { code, amount_cents }
 * and returns { gift_card_id, redeemed_cents, balance_cents }. `idempotencyKey`
 * is the ONE key for this redemption intent, reused across retries.
 */
export async function redeemGiftCard(
  accessToken: string,
  code: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<RedeemResult> {
  const response = await postEnvelope(
    "/pos/gift-cards/redeem",
    accessToken,
    { code, amount_cents: amountCents },
    undefined,
    idempotencyKey,
  );
  const inspection = inspectEnvelope<{ redemption: RedeemResult }>(response);
  if (!inspection.ok) {
    throw new Error("The redeem response was missing its provenance record; no balance is shown.");
  }
  return inspection.data.redemption;
}
