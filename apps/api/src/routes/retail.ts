import { createHash, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  createGiftCardProduct,
  createRetailProduct,
  fetchGiftCardProducts,
  fetchGiftCards,
  fetchRetailProducts,
  grantGiftCard,
  updateGiftCardProduct,
  updateRetailProduct,
} from "../data-retail.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

const idParams = z.object({ id: z.string().uuid() });
const priceCents = z.number().int().nonnegative().max(100_000_000);
const amountCents = z.number().int().positive().max(100_000_000);

const productCreate = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().min(1).max(120).nullable().optional(),
  price_cents: priceCents,
  tax_category: z.string().trim().min(1).max(80).nullable().optional(),
  active: z.boolean().default(true),
});
const productPatch = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    sku: z.string().trim().min(1).max(120).nullable().optional(),
    price_cents: priceCents.optional(),
    tax_category: z.string().trim().min(1).max(80).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

const giftCardProductCreate = z.object({
  name: z.string().trim().min(1).max(160),
  amount_cents: amountCents,
  active: z.boolean().default(true),
});
const giftCardProductPatch = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    amount_cents: amountCents.optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

// A raw code or code_hash from the client is DELIBERATELY not part of this
// schema — the server always generates the code and stores only its hash.
const grantBody = z.object({
  amount_cents: amountCents,
  person_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(1).max(500).nullable().optional(),
});

const native = { source: "native" as const, definitionVersion: "retail:v1" };

// Redemption code: 16 chars from an unambiguous alphabet, grouped for hand-off
// (~79 bits). Only its sha256 hash is ever persisted (migration 0031).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateGiftCardCode(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  }
  return out;
}

export function registerRetailRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // -- retail catalog --------------------------------------------------------
  app.get("/retail/products", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ products: await fetchRetailProducts(userClient, tenantId) }, native), 200);
  });

  app.post("/retail/products", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, productCreate);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const product = await createRetailProduct(userClient, {
      tenant_id: tenantId,
      name: body.name,
      sku: body.sku ?? null,
      price_cents: body.price_cents,
      tax_category: body.tax_category ?? null,
      active: body.active,
    });
    return c.json(c.var.ok({ product }, native), 201);
  });

  app.patch("/retail/products/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams);
    const body = await parseBody(c, productPatch);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const product = await updateRetailProduct(userClient, tenantId, id, body);
    if (product === null) throw new ApiError(404, "retail_product_not_found", "retail product not found");
    return c.json(c.var.ok({ product }, native), 200);
  });

  // -- gift-card catalog -----------------------------------------------------
  app.get("/retail/gift-card-products", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ gift_card_products: await fetchGiftCardProducts(userClient, tenantId) }, native), 200);
  });

  app.post("/retail/gift-card-products", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, giftCardProductCreate);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const gift_card_product = await createGiftCardProduct(userClient, {
      tenant_id: tenantId,
      name: body.name,
      amount_cents: body.amount_cents,
      active: body.active,
    });
    return c.json(c.var.ok({ gift_card_product }, native), 201);
  });

  app.patch("/retail/gift-card-products/:id", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const { id } = parseParams(c, idParams);
    const body = await parseBody(c, giftCardProductPatch);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const gift_card_product = await updateGiftCardProduct(userClient, tenantId, id, body);
    if (gift_card_product === null) throw new ApiError(404, "gift_card_product_not_found", "gift-card product not found");
    return c.json(c.var.ok({ gift_card_product }, native), 200);
  });

  // -- issued gift cards -----------------------------------------------------
  app.get("/retail/gift-cards", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    return c.json(c.var.ok({ gift_cards: await fetchGiftCards(userClient, tenantId) }, native), 200);
  });

  // MANUAL (comp) grant. The server GENERATES the code and stores only its
  // hash — it never accepts a raw or hashed code from the client. The raw code
  // is returned exactly ONCE here for the owner to hand over.
  app.post("/retail/gift-cards/grant", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), requireIdempotencyKey, async (c) => {
    const body = await parseBody(c, grantBody);
    const { userClient, userId } = authOf(c);
    const { tenantId } = tenantOf(c);
    const code = generateGiftCardCode();
    const codeHash = createHash("sha256").update(code).digest("hex");
    const cardId = await grantGiftCard(userClient, {
      tenantId,
      amountCents: body.amount_cents,
      codeHash,
      personId: body.person_id ?? null,
      actorId: userId,
      reason: body.reason ?? null,
    });
    return c.json(
      c.var.ok({ card_id: cardId, code, amount_cents: body.amount_cents }, native),
      201,
    );
  });
}
