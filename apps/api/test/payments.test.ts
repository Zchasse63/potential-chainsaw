import { describe, expect, it } from "vitest";
import type { KeloSupabaseClient } from "@kelo/db";
import { issueStepUpGrant } from "../src/auth/stepup.js";
import { createApp } from "../src/app.js";
import { IDEMPOTENT_REPLAY_HEADER } from "../src/middleware/mutation.js";
import { STEP_UP_GRANT_HEADER } from "../src/routes/payments.js";
import { fakeUserClient, TENANT_A, USER_ID, type RpcHandler } from "./fakes.js";

const CUSTOMER_ID = "34000000-0000-4000-8000-0000000000c1";
const PAYMENT_ID = "34000000-0000-4000-8000-000000000901";
const COMMAND_ID = "34000000-0000-4000-8000-000000000cd1";
const SECRET = "test-step-up-secret-is-at-least-32-bytes-long";
const NOW = "2026-07-18T12:00:00.000Z";

const defaultPayment = {
  id: PAYMENT_ID,
  customer_id: CUSTOMER_ID,
  amount_cents: 5000,
  currency: "usd",
  status: "requires_payment",
  stripe_payment_intent_id: null,
  command_id: COMMAND_ID,
  created_at: NOW,
  updated_at: NOW,
};

function tenantRow(settings: Record<string, unknown>) {
  return {
    id: TENANT_A,
    name: "Tenant A",
    slug: "tenant-a",
    settings,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
}

// -- A stateful in-memory fake of the idempotency_keys surface for the BILLING
// client the persisted idempotency middleware uses (mirrors idempotency.test.ts,
// enforcing the (tenant_id, key) unique index so reserve/replay run for real).
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
    const matches = (row: IdemRow) =>
      filters.every((f) => (row as unknown as Record<string, unknown>)[f.col] === f.val);
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

function userFake(opts: {
  role: string;
  payment?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  rpc?: Record<string, RpcHandler>;
}) {
  const payment = opts.payment === undefined ? defaultPayment : opts.payment;
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: opts.role }] }),
      tenants: () => ({ data: [tenantRow(opts.settings ?? {})] }),
      payments: () => ({ data: payment === null ? [] : [payment] }),
    },
    opts.rpc ?? {
      create_payment_intent: () => ({ data: PAYMENT_ID }),
      create_refund: () => ({ data: COMMAND_ID }),
    },
  );
}

function appFor(fake: ReturnType<typeof fakeUserClient>, billing = makeBillingClient()) {
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
    createBillingClient: () => billing.client,
    env: { STEP_UP_SECRET: SECRET },
  });
  return { app, fake };
}

function intentReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer t",
      "content-type": "application/json",
      "idempotency-key": "pi-key",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

describe("POST /payments/intents — create a payment intent (outbox command)", () => {
  it("threads the client Idempotency-Key into the RPC and returns the PENDING payment", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/payments/intents",
      intentReq({ customer_id: CUSTOMER_ID, amount_cents: 5000 }, { "idempotency-key": "pi-1" }),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { data: { payment: { status: string; id: string } } };
    // Never a success claim before the provider — the payment is pending.
    expect(payload.data.payment.status).toBe("requires_payment");

    const rpc = fake.calls.find((c) => c.table === "create_payment_intent");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_idempotency_key).toBe("pi-1"); // request + outbox share the key
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_customer).toBe(CUSTOMER_ID);
    expect(params.p_amount_cents).toBe(5000);
  });

  it("is idempotent: a repeated POST replays the stored response and writes ONE command", async () => {
    const fake = userFake({ role: "owner" });
    const { app } = appFor(fake);
    const send = () =>
      app.request(
        "/api/v1/payments/intents",
        intentReq({ customer_id: CUSTOMER_ID, amount_cents: 5000 }, { "idempotency-key": "pi-dup" }),
      );

    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("true");

    // The RPC (the sole command writer) ran exactly once across both requests.
    const rpcCalls = fake.calls.filter((c) => c.table === "create_payment_intent");
    expect(rpcCalls).toHaveLength(1);
  });

  it("422s without an Idempotency-Key and never reaches the RPC", async () => {
    const fake = userFake({ role: "owner" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/payments/intents", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ customer_id: CUSTOMER_ID, amount_cents: 5000 }),
    });
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "create_payment_intent")).toBe(false);
  });

  it("403s a trainer (no payment-taking role) before the RPC", async () => {
    const fake = userFake({ role: "trainer" });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/payments/intents",
      intentReq({ customer_id: CUSTOMER_ID, amount_cents: 5000 }),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "create_payment_intent")).toBe(false);
  });

  it("surfaces the RPC's typed refusal (a foreign customer → 404)", async () => {
    const fake = userFake({
      role: "owner",
      rpc: {
        create_payment_intent: () => ({
          data: null,
          error: { code: "P0002", message: "customer not found for tenant" },
        }),
      },
    });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/payments/intents",
      intentReq({ customer_id: CUSTOMER_ID, amount_cents: 5000 }),
    );
    expect(res.status).toBe(404);
  });
});

function refundReq(amount: number, headers: Record<string, string> = {}, reason?: string) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer t",
      "content-type": "application/json",
      "idempotency-key": `rf-${amount}-${Object.keys(headers).length}`,
      ...headers,
    },
    body: JSON.stringify(reason === undefined ? { amount_cents: amount } : { amount_cents: amount, reason }),
  };
}

describe("POST /payments/:id/refund — refund a succeeded payment (webhook confirms)", () => {
  it("below the threshold: refunds without a step-up grant and returns PENDING (202)", async () => {
    const fake = userFake({ role: "manager", settings: { refund_step_up_cents: 10000 } });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/payments/${PAYMENT_ID}/refund`, refundReq(5000, {}, "duplicate"));
    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      data: { refund: { command_id: string; status: string; payment_id: string } };
    };
    expect(payload.data.refund.status).toBe("pending");
    expect(payload.data.refund.command_id).toBe(COMMAND_ID);
    expect(payload.data.refund.payment_id).toBe(PAYMENT_ID);

    const rpc = fake.calls.find((c) => c.table === "create_refund");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_payment).toBe(PAYMENT_ID);
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_reason).toBe("duplicate");
  });

  it("above the threshold with NO grant: 401 step_up_required and the RPC is not called", async () => {
    const fake = userFake({ role: "manager", settings: { refund_step_up_cents: 10000 } });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/payments/${PAYMENT_ID}/refund`, refundReq(25000));
    expect(res.status).toBe(401);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("step_up_required");
    expect(fake.calls.some((c) => c.table === "create_refund")).toBe(false);
  });

  it("above the threshold with a VALID manager grant: proceeds (202)", async () => {
    const fake = userFake({ role: "manager", settings: { refund_step_up_cents: 10000 } });
    const { app } = appFor(fake);
    const grant = issueStepUpGrant(
      { sub: USER_ID, tenant: TENANT_A, context: "refund_over_threshold" },
      SECRET,
    );
    const res = await app.request(
      `/api/v1/payments/${PAYMENT_ID}/refund`,
      refundReq(25000, { [STEP_UP_GRANT_HEADER]: grant }),
    );
    expect(res.status).toBe(202);
    expect(fake.calls.some((c) => c.table === "create_refund")).toBe(true);
  });

  it("rejects a grant minted for a DIFFERENT context (401, no RPC)", async () => {
    const fake = userFake({ role: "manager", settings: { refund_step_up_cents: 10000 } });
    const { app } = appFor(fake);
    const wrongContext = issueStepUpGrant(
      { sub: USER_ID, tenant: TENANT_A, context: "manual_grant" },
      SECRET,
    );
    const res = await app.request(
      `/api/v1/payments/${PAYMENT_ID}/refund`,
      refundReq(25000, { [STEP_UP_GRANT_HEADER]: wrongContext }),
    );
    expect(res.status).toBe(401);
    expect(fake.calls.some((c) => c.table === "create_refund")).toBe(false);
  });

  it("honors a custom tenant threshold: $20 needs a grant when the threshold is $15", async () => {
    const fake = userFake({ role: "owner", settings: { refund_step_up_cents: 1500 } });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/payments/${PAYMENT_ID}/refund`, refundReq(2000));
    expect(res.status).toBe(401);
    expect(fake.calls.some((c) => c.table === "create_refund")).toBe(false);
  });

  it("maps the RPC's refundable/succeeded rejection (22023) to 422", async () => {
    const fake = userFake({
      role: "owner",
      settings: { refund_step_up_cents: 10000 },
      rpc: {
        create_refund: () => ({
          data: null,
          error: { code: "22023", message: "only a succeeded payment can be refunded (status processing)" },
        }),
      },
    });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/payments/${PAYMENT_ID}/refund`, refundReq(5000));
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("succeeded");
  });

  it("role-gates the refund: a trainer is 403 and never reaches the RPC", async () => {
    const fake = userFake({ role: "trainer" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/payments/${PAYMENT_ID}/refund`, refundReq(5000));
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "create_refund")).toBe(false);
  });

  it("role-gates the refund: front_desk (a payment-taker) is 403 on refund", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/payments/${PAYMENT_ID}/refund`, refundReq(5000));
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "create_refund")).toBe(false);
  });
});
