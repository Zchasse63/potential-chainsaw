import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { withBalances } from "../src/data-retail.js";
import { TENANT_A, USER_ID, fakeUserClient } from "./fakes.js";

const CARD_ID = "31000000-0000-4000-8000-000000000c01";
const PRODUCT_ID = "31000000-0000-4000-8000-000000000101";
const PERSON_ID = "31000000-0000-4000-8000-0000000000f1";

const product = {
  id: PRODUCT_ID,
  name: "Recovery towel",
  sku: "TWL-01",
  price_cents: 3500,
  tax_category: "goods",
  active: true,
  created_at: "2026-07-18T12:00:00.000Z",
};

function retailFake(role: "owner" | "front_desk", overrides: Record<string, () => { data: unknown }> = {}) {
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
      retail_products: () => ({ data: [product] }),
      gift_card_products: () => ({ data: [] }),
      gift_cards: () => ({ data: [] }),
      gift_card_ledger: () => ({ data: [] }),
      ...overrides,
    },
    { grant_gift_card: () => ({ data: CARD_ID }) },
  );
}

function appFor(fake: ReturnType<typeof fakeUserClient>) {
  return createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
  });
}

describe("retail — gift-card manual grant", () => {
  it("is owner/manager-gated: front_desk is 403 and never reaches the grant RPC", async () => {
    const fake = retailFake("front_desk");
    const response = await appFor(fake).request("/api/v1/retail/gift-cards/grant", {
      method: "POST",
      headers: { authorization: "Bearer t", "idempotency-key": "grant-1" },
      body: JSON.stringify({ amount_cents: 5000 }),
    });
    expect(response.status).toBe(403);
    expect(fake.calls.some((call) => call.table === "grant_gift_card")).toBe(false);
  });

  it("requires an idempotency key", async () => {
    const fake = retailFake("owner");
    const response = await appFor(fake).request("/api/v1/retail/gift-cards/grant", {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: JSON.stringify({ amount_cents: 5000 }),
    });
    expect(response.status).toBe(422);
    expect(fake.calls.some((call) => call.table === "grant_gift_card")).toBe(false);
  });

  it("issues a card via the RPC, binds the authenticated actor, and returns the one-time code", async () => {
    const fake = retailFake("owner");
    const response = await appFor(fake).request("/api/v1/retail/gift-cards/grant", {
      method: "POST",
      headers: { authorization: "Bearer t", "idempotency-key": "grant-2" },
      body: JSON.stringify({ amount_cents: 5000, person_id: PERSON_ID, reason: "loyalty comp" }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { data: { card_id: string; code: string; amount_cents: number } };
    expect(payload.data.card_id).toBe(CARD_ID);
    expect(payload.data.amount_cents).toBe(5000);
    expect(payload.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const rpc = fake.calls.find((call) => call.table === "grant_gift_card");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_amount_cents).toBe(5000);
    expect(params.p_person).toBe(PERSON_ID);
    expect(params.p_reason).toBe("loyalty comp");
  });

  it("HASHES the code server-side and never trusts a client-supplied code or hash", async () => {
    const fake = retailFake("owner");
    const clientHash = "deadbeef".repeat(8);
    const response = await appFor(fake).request("/api/v1/retail/gift-cards/grant", {
      method: "POST",
      headers: { authorization: "Bearer t", "idempotency-key": "grant-3" },
      // A hostile client tries to smuggle its own code + hash.
      body: JSON.stringify({ amount_cents: 2500, code: "GIFT-ME-FREE", code_hash: clientHash }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { data: { code: string } };
    const rpc = fake.calls.find((call) => call.table === "grant_gift_card");
    const params = rpc?.args[0] as Record<string, unknown>;

    // The stored hash is sha256 of the SERVER-generated code, not the client's.
    const expectedHash = createHash("sha256").update(payload.data.code).digest("hex");
    expect(params.p_code_hash).toBe(expectedHash);
    expect(params.p_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(params.p_code_hash).not.toBe(clientHash);
    expect(payload.data.code).not.toBe("GIFT-ME-FREE");
  });
});

describe("retail — append-only ledger + balance", () => {
  it("balance is the signed sum of the ledger (invariant #6)", () => {
    const cards = [
      { id: "card-a", issued_to_person_id: null, status: "active" as const, created_at: "2026-07-18T00:00:00.000Z" },
      { id: "card-b", issued_to_person_id: null, status: "active" as const, created_at: "2026-07-18T00:00:00.000Z" },
    ];
    const ledger = [
      { gift_card_id: "card-a", amount_cents: 5000 }, // issue
      { gift_card_id: "card-a", amount_cents: -1500 }, // redeem
      { gift_card_id: "card-a", amount_cents: -500 }, // redeem
    ];
    const withBal = withBalances(cards, ledger);
    expect(withBal.find((c) => c.id === "card-a")?.balance_cents).toBe(3000);
    // A card with no ledger entries is exactly zero, never null.
    expect(withBal.find((c) => c.id === "card-b")?.balance_cents).toBe(0);
  });

  it("reads the issued-card list without any update/delete against the ledger", async () => {
    const fake = retailFake("owner", {
      gift_cards: () => ({ data: [{ id: CARD_ID, issued_to_person_id: null, status: "active", created_at: "2026-07-18T00:00:00.000Z" }] }),
      gift_card_ledger: () => ({ data: [{ gift_card_id: CARD_ID, amount_cents: 5000 }] }),
    });
    const response = await appFor(fake).request("/api/v1/retail/gift-cards", {
      headers: { authorization: "Bearer t" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { gift_cards: { id: string; balance_cents: number }[] } };
    expect(payload.data.gift_cards[0]?.balance_cents).toBe(5000);

    // The append-only invariant, proven at the code path: every call the API
    // makes against the ledger is a read; there is NO mutation method anywhere.
    const ledgerCalls = fake.calls.filter((call) => call.table === "gift_card_ledger");
    expect(ledgerCalls.length).toBeGreaterThan(0);
    expect(ledgerCalls.every((call) => call.method === "select" || call.method === "eq")).toBe(true);
    expect(fake.calls.some((call) => call.table === "gift_card_ledger" && (call.method === "update" || call.method === "delete"))).toBe(false);
  });
});

describe("retail — catalog CRUD role-gating", () => {
  it("blocks front_desk from creating a retail product", async () => {
    const fake = retailFake("front_desk");
    const response = await appFor(fake).request("/api/v1/retail/products", {
      method: "POST",
      headers: { authorization: "Bearer t", "idempotency-key": "prod-1" },
      body: JSON.stringify({ name: "Recovery towel", price_cents: 3500 }),
    });
    expect(response.status).toBe(403);
    expect(fake.calls.some((call) => call.table === "retail_products" && call.method === "insert")).toBe(false);
  });

  it("lets an owner create a retail product and returns it through the envelope", async () => {
    const fake = retailFake("owner");
    const response = await appFor(fake).request("/api/v1/retail/products", {
      method: "POST",
      headers: { authorization: "Bearer t", "idempotency-key": "prod-2" },
      body: JSON.stringify({ name: "Recovery towel", sku: "TWL-01", price_cents: 3500, tax_category: "goods" }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { data: { product: { price_cents: number } }; meta: { source: string } };
    expect(payload.data.product.price_cents).toBe(3500);
    expect(payload.meta.source).toBe("native");
    const insert = fake.calls.find((call) => call.table === "retail_products" && call.method === "insert");
    expect((insert?.args[0] as { tenant_id: string }).tenant_id).toBe(TENANT_A);
  });

  it("lets an owner list the catalog without a role wall", async () => {
    const fake = retailFake("front_desk");
    const response = await appFor(fake).request("/api/v1/retail/products", {
      headers: { authorization: "Bearer t" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { products: unknown[] } };
    expect(payload.data.products).toHaveLength(1);
  });
});
