import { describe, expect, it } from "vitest";
import type { KeloSupabaseClient } from "@kelo/db";
import { createApp } from "../src/app.js";
import { IDEMPOTENT_REPLAY_HEADER } from "../src/middleware/mutation.js";
import { fakeUserClient, TENANT_A, USER_ID, type RecordedCall, type RpcHandler } from "./fakes.js";

/**
 * Unit 5.7 — POS money routes (/pos/checkout, /pos/gift-cards/redeem,
 * /pos/orders). Invariant #5 (money mutations are RPCs with idempotency keys,
 * server-priced, no optimistic UI). The security-critical route logic proven
 * here: the role gate (owner/manager/front_desk only), the Idempotency-Key 422,
 * persisted-idempotency REPLAY, the data-pos.ts RPC-error → HTTP mapping, and
 * that no client-supplied price is ever sent to the RPC.
 */

const NOW = "2026-07-18T12:00:00.000Z";
const ORDER_ID = "5c000000-0000-4000-8000-000000000001";
const PAYMENT_ID = "5c000000-0000-4000-8000-000000000002";
const CARD_ID = "5c000000-0000-4000-8000-000000000003";
const RETAIL_REF = "5c000000-0000-4000-8000-0000000000a1";

function tenantRow() {
  return { id: TENANT_A, name: "Tenant A", slug: "tenant-a", settings: {}, status: "active", created_at: NOW, updated_at: NOW };
}

const defaultOrder = {
  id: ORDER_ID,
  person_id: null,
  payment_id: PAYMENT_ID,
  subtotal_cents: 5000,
  discount_cents: 0,
  tax_cents: 0,
  total_cents: 5000,
  tender: "cash",
  created_at: NOW,
  pos_order_lines: [],
};

// Stateful idempotency_keys fake for the BILLING client persistIdempotency uses
// — enforces the (tenant_id, key) unique index so reserve/replay run for real
// (mirrors payments.test.ts / idempotency.test.ts).
interface IdemRow {
  tenant_id: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}
function makeBillingClient(): { client: KeloSupabaseClient } {
  const store = new Map<string, IdemRow>();
  const idOf = (t: string, k: string) => `${t}|${k}`;
  function builder() {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let values: Record<string, unknown> = {};
    const filters: { col: string; val: unknown }[] = [];
    const matches = (row: IdemRow) => filters.every((f) => (row as unknown as Record<string, unknown>)[f.col] === f.val);
    function execute() {
      if (op === "insert") {
        const id = idOf(String(values.tenant_id), String(values.key));
        if (store.has(id)) return { data: null, error: { message: "dup", code: "23505" } };
        store.set(id, {
          tenant_id: String(values.tenant_id),
          key: String(values.key),
          request_hash: String(values.request_hash),
          response_status: null,
          response_body: null,
        });
        return { data: [store.get(id)], error: null };
      }
      if (op === "update") {
        for (const row of store.values()) {
          if (!matches(row)) continue;
          if ("response_status" in values) row.response_status = values.response_status as number;
          if ("response_body" in values) row.response_body = values.response_body;
        }
        return { data: null, error: null };
      }
      if (op === "delete") {
        for (const [id, row] of [...store.entries()]) if (matches(row)) store.delete(id);
        return { data: null, error: null };
      }
      return {
        data: [...store.values()].filter(matches).map((r) => ({
          request_hash: r.request_hash,
          response_status: r.response_status,
          response_body: r.response_body,
        })),
        error: null,
      };
    }
    const api: Record<string, unknown> = {
      select() {
        if (op !== "insert") op = "select";
        return api;
      },
      insert(v: Record<string, unknown>) {
        op = "insert";
        values = v;
        return api;
      },
      update(v: Record<string, unknown>) {
        op = "update";
        values = v;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      is(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      limit() {
        return api;
      },
      then(resolve: (r: unknown) => void) {
        resolve(execute());
      },
    };
    return api;
  }
  return { client: { from: () => builder() } as unknown as KeloSupabaseClient };
}

function userFake(opts: { role: string; rpc?: Record<string, RpcHandler>; orders?: unknown[] }) {
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: opts.role }] }),
      tenants: () => ({ data: [tenantRow()] }),
      pos_orders: () => ({ data: opts.orders ?? [defaultOrder] }),
    },
    opts.rpc ?? {
      pos_checkout: () => ({ data: { payment_id: PAYMENT_ID, order_id: ORDER_ID } }),
      redeem_gift_card: () => ({ data: { gift_card_id: CARD_ID, redeemed_cents: 2500, balance_cents: 2500 } }),
    },
  );
}

function appFor(fake: ReturnType<typeof fakeUserClient>, billing = makeBillingClient()) {
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
    createBillingClient: () => billing.client,
  });
  return { app, fake, billing };
}

function checkoutReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": "co-1", ...headers },
    body: JSON.stringify(body),
  };
}

const cashLine = { tender: "cash" as const, lines: [{ kind: "retail" as const, ref_id: RETAIL_REF, qty: 1 }] };

describe("POST /pos/checkout", () => {
  it("threads the Idempotency-Key + server-priced lines into the RPC (no client amount) and returns 201", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    // A client-sent `amount_cents`/`total` must be ignored — the schema has no price field.
    const res = await app.request(
      "/api/v1/pos/checkout",
      checkoutReq({ ...cashLine, discount_cents: 0, amount_cents: 999999, total: 1 }, { "idempotency-key": "co-A" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { checkout: { payment_id: string; order_id: string } } };
    expect(body.data.checkout.order_id).toBe(ORDER_ID);

    const rpc = fake.calls.find((c) => c.table === "pos_checkout");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_idempotency_key).toBe("co-A");
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_tender).toBe("cash");
    expect(params.p_lines).toEqual([{ kind: "retail", ref_id: RETAIL_REF, qty: 1 }]);
    // No client price ever reaches the RPC.
    expect(JSON.stringify(params)).not.toContain("999999");
  });

  it("replays idempotently: the same key returns the stored response and calls the RPC once", async () => {
    const fake = userFake({ role: "front_desk" });
    const billing = makeBillingClient();
    const { app } = appFor(fake, billing);
    const first = await app.request("/api/v1/pos/checkout", checkoutReq(cashLine, { "idempotency-key": "co-R" }));
    expect(first.status).toBe(201);
    const second = await app.request("/api/v1/pos/checkout", checkoutReq(cashLine, { "idempotency-key": "co-R" }));
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeTruthy();
    // The money RPC ran exactly once across the two requests.
    expect(fake.calls.filter((c: RecordedCall) => c.table === "pos_checkout")).toHaveLength(1);
  });

  it("422s without an Idempotency-Key and never calls the RPC", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/pos/checkout", checkoutReq(cashLine, { "idempotency-key": "" }));
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "pos_checkout")).toBe(false);
  });

  it("403s for a role outside owner/manager/front_desk (trainer) before the RPC", async () => {
    const fake = userFake({ role: "trainer" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/pos/checkout", checkoutReq(cashLine));
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "pos_checkout")).toBe(false);
  });

  it("maps the RPC error taxonomy: 22023→422, P0002→404, 23505→409, 42501→403", async () => {
    const cases: { code: string; status: number; errCode: string }[] = [
      { code: "22023", status: 422, errCode: "pos_invalid" },
      { code: "P0002", status: 404, errCode: "pos_target_not_found" },
      { code: "23505", status: 409, errCode: "idempotency_key_conflict" },
      { code: "42501", status: 403, errCode: "pos_forbidden" },
    ];
    for (const [i, tc] of cases.entries()) {
      const fake = userFake({
        role: "manager",
        rpc: { pos_checkout: () => ({ error: { code: tc.code, message: "x" } }) },
      });
      const { app } = appFor(fake);
      const res = await app.request("/api/v1/pos/checkout", checkoutReq(cashLine, { "idempotency-key": `co-e${i}` }));
      expect(res.status, tc.code).toBe(tc.status);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code, tc.code).toBe(tc.errCode);
    }
  });
});

describe("POST /pos/gift-cards/redeem", () => {
  it("redeems against the append-only ledger and returns the new balance", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/pos/gift-cards/redeem",
      checkoutReq({ code: "GC-RAW-CODE", amount_cents: 2500 }, { "idempotency-key": "rd-1" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { redemption: { balance_cents: number } } };
    expect(body.data.redemption.balance_cents).toBe(2500);
    // The raw code goes only to the RPC (hashed there), never echoed in the response.
    expect(JSON.stringify(body)).not.toContain("GC-RAW-CODE");
  });

  it("over-redemption (RPC 22023) → 422 pos_invalid, no ledger mutation from the route", async () => {
    const fake = userFake({
      role: "front_desk",
      rpc: { redeem_gift_card: () => ({ error: { code: "22023", message: "redemption exceeds balance" } }) },
    });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/pos/gift-cards/redeem",
      checkoutReq({ code: "GC", amount_cents: 999999 }, { "idempotency-key": "rd-2" }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("pos_invalid");
  });

  it("403s a role outside the allowed set before the RPC", async () => {
    const fake = userFake({ role: "trainer" });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/pos/gift-cards/redeem",
      checkoutReq({ code: "GC", amount_cents: 100 }),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "redeem_gift_card")).toBe(false);
  });
});

describe("GET /pos/orders", () => {
  it("returns the RLS-scoped order list", async () => {
    const fake = userFake({ role: "manager" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/pos/orders", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orders: { id: string }[] }; meta: { source: string } };
    expect(body.data.orders[0]?.id).toBe(ORDER_ID);
    expect(body.meta.source).toBe("native");
  });
});
