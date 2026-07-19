import type { Hono } from "hono";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import { fetchOrders, posCheckout, redeemGiftCard } from "../data-pos.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { persistIdempotency } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody } from "../validate.js";

const amountCents = z.number().int().positive().max(100_000_000);
const discountCents = z.number().int().nonnegative().max(100_000_000);

const checkoutLine = z.object({
  kind: z.enum(["retail", "gift_card", "drop_in"]),
  ref_id: z.string().uuid(),
  qty: z.number().int().positive().max(1000),
});

// Prices are DELIBERATELY absent from the schema — the server resolves every
// line price from the live catalog; a client-sent amount is never accepted.
const checkoutBody = z.object({
  person_id: z.string().uuid().nullable().optional(),
  tender: z.enum(["cash", "stripe", "gift_card"]),
  // Settlement card code (tender='gift_card' only) — hashed server-side in the RPC.
  gift_card_code: z.string().trim().min(1).max(200).optional(),
  lines: z.array(checkoutLine).min(1).max(200),
  discount_cents: discountCents.default(0),
});

const redeemBody = z.object({
  code: z.string().trim().min(1).max(128),
  amount_cents: amountCents,
});

const native = { source: "native" as const, definitionVersion: "pos:v1" };

/** The client Idempotency-Key, guaranteed present by persistIdempotency. */
function idempotencyKeyOf(c: { req: { header: (name: string) => string | undefined } }): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(422, "idempotency_key_required", `${IDEMPOTENCY_KEY_HEADER} header is required`);
  }
  return key;
}

/**
 * The POS backend (unit 5.7; invariant #5). Every mutation runs requireAuth →
 * resolveTenant (SOLE tenant source) → requireRole (owner/manager/front_desk) →
 * persisted idempotency, then calls a Postgres money RPC that prices server-side
 * and writes the ledger/outbox — NO client amounts, NO optimistic money UI. The
 * client Idempotency-Key threads into the RPC so request-level and
 * outbox/order-level idempotency share it.
 *
 * `createBillingClient` is the service-role seam the persisted idempotency
 * middleware uses to reserve/store/replay the idempotency_keys row (member-SELECT
 * RLS; the service role writes). Tests inject a no-network fake.
 */
export function registerPosRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  createBillingClient: () => KeloSupabaseClient = createServiceRoleClient,
): void {
  // -- orders list (member read, with lines) ---------------------------------
  app.get("/pos/orders", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ orders: await fetchOrders(userClient, tenantId) }, native), 200);
  });

  // -- checkout (owner/manager/front_desk; discount narrows to owner/manager) -
  // The RPC prices every line from the live catalog and computes the total.
  // Cash → a succeeded payment recorded in-body + inline gift-card issuance +
  // receipt; stripe → requires_payment + a create_payment_intent outbox command
  // (the seam for a live Terminal/Connect account). NO optimistic money status.
  app.post(
    "/pos/checkout",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const body = await parseBody(c, checkoutBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const result = await posCheckout(userClient, {
        tenantId,
        actorId: userId,
        idempotencyKey: idempotencyKeyOf(c),
        personId: body.person_id ?? null,
        lines: body.lines,
        tender: body.tender,
        giftCardCode: body.gift_card_code ?? null,
        discountCents: body.discount_cents,
      });
      return c.json(c.var.ok({ checkout: result }, native), 201);
    },
  );

  // -- gift-card redemption (owner/manager/front_desk) ------------------------
  // Appends a negative 'redeem' entry to the append-only ledger; over-redemption
  // is refused and the card row is FOR UPDATE-locked to serialize concurrency.
  app.post(
    "/pos/gift-cards/redeem",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const body = await parseBody(c, redeemBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const result = await redeemGiftCard(userClient, {
        tenantId,
        actorId: userId,
        code: body.code,
        amountCents: body.amount_cents,
        idempotencyKey: idempotencyKeyOf(c),
      });
      return c.json(c.var.ok({ redemption: result }, native), 201);
    },
  );
}
