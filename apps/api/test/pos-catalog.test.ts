import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID } from "./fakes.js";

const NOW = "2026-07-19T12:00:00.000Z";

const RET_1 = "40000000-0000-4000-8000-000000000101";
const RET_2 = "40000000-0000-4000-8000-000000000102";
const GC_1 = "40000000-0000-4000-8000-000000000201";
const GC_2 = "40000000-0000-4000-8000-000000000202";
const PLAN_1 = "40000000-0000-4000-8000-000000000301";
const PLAN_2 = "40000000-0000-4000-8000-000000000302";

const RETAIL = [
  { id: RET_1, name: "Recovery towel", sku: "TWL-01", price_cents: 3500, tax_category: "goods", active: true, created_at: NOW },
  { id: RET_2, name: "Retired hoodie", sku: "HOD-09", price_cents: 6000, tax_category: "goods", active: false, created_at: NOW },
];
const GIFT = [
  { id: GC_1, name: "Fifty", amount_cents: 5000, active: true, created_at: NOW },
  { id: GC_2, name: "Paused", amount_cents: 2000, active: false, created_at: NOW },
];
const PLANS = [
  { id: PLAN_1, name: "Single class" },
  { id: PLAN_2, name: "Unpriced drop-in" },
];
const PRICES = [
  // plan-1 has a current (non-superseded) one-time price; plan-2 has none.
  { plan_id: PLAN_1, amount_cents: 2500, currency: "usd", effective_from: NOW },
];

function catalogFake(role: string) {
  return fakeUserClient({
    tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
    tenants: () => ({
      data: [
        {
          id: TENANT_A,
          name: "Tenant A",
          slug: "tenant-a",
          settings: {},
          status: "active",
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    }),
    retail_products: () => ({ data: RETAIL }),
    gift_card_products: () => ({ data: GIFT }),
    plans: () => ({ data: PLANS }),
    plan_prices: () => ({ data: PRICES }),
  });
}

function appFor(fake: ReturnType<typeof fakeUserClient>) {
  return createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
    env: { STEP_UP_SECRET: "test-step-up-secret-is-at-least-32-bytes-long" },
  });
}

function getReq() {
  return { method: "GET", headers: { authorization: "Bearer t" } };
}

describe("GET /pos/catalog — the server-priced picker source", () => {
  for (const role of ["owner", "manager", "front_desk"] as const) {
    it(`serves ${role} a catalog of active, server-priced lines only`, async () => {
      const fake = catalogFake(role);
      const app = appFor(fake);
      const res = await app.request("/api/v1/pos/catalog", getReq());
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        data: {
          retail_products: { id: string }[];
          gift_card_products: { id: string }[];
          drop_in_plans: { id: string; amount_cents: number }[];
        };
        meta: { source: string };
      };
      // Inactive retail + gift-card products are not ringable.
      expect(payload.data.retail_products.map((p) => p.id)).toEqual([RET_1]);
      expect(payload.data.gift_card_products.map((p) => p.id)).toEqual([GC_1]);
      // Only drop-ins with a current price are sellable; the price comes from
      // plan_prices, never the client.
      expect(payload.data.drop_in_plans).toEqual([
        { id: PLAN_1, name: "Single class", amount_cents: 2500, currency: "usd" },
      ]);
      expect(payload.meta.source).toBe("native");
    });
  }

  it("403s a trainer before any catalog read", async () => {
    const fake = catalogFake("trainer");
    const app = appFor(fake);
    const res = await app.request("/api/v1/pos/catalog", getReq());
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "retail_products")).toBe(false);
    expect(fake.calls.some((c) => c.table === "plans")).toBe(false);
  });
});
