import type { Hono } from "hono";
import { fetchGiftCardProducts, fetchRetailProducts } from "../data-retail.js";
import { fetchDropInPlans } from "../data-pos-catalog.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";

const native = { source: "native" as const, definitionVersion: "pos-catalog:v1" };

/**
 * The POS catalog read (unit 5.8). A single owner/manager/front_desk GET that
 * aggregates the three sellable line kinds — retail products, gift-card
 * denominations, and priced drop-in plans — so the cash checkout screen can
 * render a picker WITHOUT the client ever holding a price it authored: the
 * screen posts { kind, ref, qty } and the checkout RPC (unit 5.7) re-prices
 * from these same tables. All reads run through the user-scoped client (RLS
 * scopes rows to the caller's tenant; invariant #7). This route intentionally
 * ships ONLY the read; the money mutations (checkout/redeem) are the sibling
 * unit's outbox-backed RPCs.
 */
export function registerPosCatalogRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.get(
    "/pos/catalog",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const [retail_products, gift_card_products, drop_in_plans] = await Promise.all([
        fetchRetailProducts(userClient, tenantId),
        fetchGiftCardProducts(userClient, tenantId),
        fetchDropInPlans(userClient, tenantId),
      ]);
      return c.json(
        c.var.ok(
          {
            // Only sellable (active) lines reach the picker; a paused product
            // is not ringable.
            retail_products: retail_products.filter((product) => product.active),
            gift_card_products: gift_card_products.filter((product) => product.active),
            drop_in_plans,
          },
          native,
        ),
        200,
      );
    },
  );
}
