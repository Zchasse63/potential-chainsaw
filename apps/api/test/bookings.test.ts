import { describe, expect, it } from "vitest";
import type { KeloSupabaseClient } from "@kelo/db";
import { createApp } from "../src/app.js";
import { IDEMPOTENT_REPLAY_HEADER } from "../src/middleware/mutation.js";
import { fakeUserClient, TENANT_A, USER_ID, type RpcHandler } from "./fakes.js";

const SESSION_ID = "40000000-0000-4000-8000-000000000501";
const PERSON_ID = "40000000-0000-4000-8000-000000000601";
const HOLD_ID = "40000000-0000-4000-8000-000000000701";
const BOOKING_ID = "40000000-0000-4000-8000-000000000801";
const CREDIT_ID = "40000000-0000-4000-8000-000000000901";
const FROM = "2026-07-20T00:00:00.000Z";
const TO = "2026-07-21T00:00:00.000Z";

const availabilityRow = {
  session_id: SESSION_ID,
  starts_at: "2026-07-20T18:00:00.000Z",
  capacity: 12,
  booked: 3,
  held: 1,
  available: 8,
  readiness_ok: true,
};

// -- A stateful in-memory fake of the idempotency_keys surface for the BILLING
// client persistIdempotency uses on the money-adjacent booking routes (mirrors
// payments.test.ts — enforces the (tenant_id, key) unique index so reserve/
// replay run for real).
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

const defaultRpc: Record<string, RpcHandler> = {
  session_availability: () => ({ data: [availabilityRow] }),
  hold_session: () => ({ data: HOLD_ID }),
  freeze_hold: () => ({ data: null }),
  release_hold: () => ({ data: true }),
  book_session: () => ({ data: { booking_id: BOOKING_ID, credit_entry_id: CREDIT_ID } }),
  cancel_booking: () => ({
    data: { booking_id: BOOKING_ID, status: "cancelled", branch: "refund", refunded: true, credit_entry_id: CREDIT_ID },
  }),
};

function userFake(role: string, rpc: Record<string, RpcHandler> = defaultRpc) {
  return fakeUserClient({ tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }) }, rpc);
}

function appFor(fake: ReturnType<typeof fakeUserClient>) {
  const billing = makeBillingClient();
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
    createBillingClient: () => billing.client,
  });
  return { app, fake };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer t",
      "content-type": "application/json",
      "idempotency-key": "bk-key",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

// -- GET /sessions/availability -------------------------------------------------

describe("GET /sessions/availability — member-read picker", () => {
  it("threads the window into the RPC and returns availability rows (any member)", async () => {
    const fake = userFake("trainer");
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/sessions/availability?from=${FROM}&to=${TO}`, {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { sessions: { available: number }[] } };
    expect(payload.data.sessions).toHaveLength(1);
    expect(payload.data.sessions[0]?.available).toBe(8);

    const rpc = fake.calls.find((c) => c.table === "session_availability");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_from).toBe(FROM);
    expect(params.p_to).toBe(TO);
  });

  it("422s a window where to is not after from, before the RPC", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/sessions/availability?from=${TO}&to=${FROM}`, {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "session_availability")).toBe(false);
  });
});

// -- POST /bookings/hold --------------------------------------------------------

describe("POST /bookings/hold — reserve a seat (owner/manager/front_desk)", () => {
  it("threads the actor + TTL into hold_session and returns the hold", async () => {
    const fake = userFake("front_desk");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/bookings/hold",
      post("/bookings/hold", { session_id: SESSION_ID, person_id: PERSON_ID, ttl_seconds: 120 }),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { data: { hold: { hold_id: string } } };
    expect(payload.data.hold.hold_id).toBe(HOLD_ID);

    const rpc = fake.calls.find((c) => c.table === "hold_session");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_session).toBe(SESSION_ID);
    expect(params.p_person).toBe(PERSON_ID);
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_ttl_seconds).toBe(120);
  });

  it("defaults the TTL to 300s when omitted", async () => {
    const fake = userFake("manager");
    const { app } = appFor(fake);
    await app.request(
      "/api/v1/bookings/hold",
      post("/bookings/hold", { session_id: SESSION_ID, person_id: PERSON_ID }),
    );
    const rpc = fake.calls.find((c) => c.table === "hold_session");
    expect((rpc?.args[0] as Record<string, unknown>).p_ttl_seconds).toBe(300);
  });

  it("403s a trainer (no desk role) before the RPC", async () => {
    const fake = userFake("trainer");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/bookings/hold",
      post("/bookings/hold", { session_id: SESSION_ID, person_id: PERSON_ID }),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "hold_session")).toBe(false);
  });

  it("422s without an Idempotency-Key and never reaches the RPC", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/bookings/hold", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ session_id: SESSION_ID, person_id: PERSON_ID }),
    });
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "hold_session")).toBe(false);
  });
});

// -- POST /bookings -------------------------------------------------------------

describe("POST /bookings — book a session (debits one credit)", () => {
  it("threads the client Idempotency-Key into p_idempotency_key and fixes p_via=desk", async () => {
    const fake = userFake("front_desk");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/bookings",
      post("/bookings", { session_id: SESSION_ID, person_id: PERSON_ID, hold_id: HOLD_ID }, { "idempotency-key": "bk-1" }),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { data: { booking: { booking_id: string } } };
    expect(payload.data.booking.booking_id).toBe(BOOKING_ID);

    const rpc = fake.calls.find((c) => c.table === "book_session");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_idempotency_key).toBe("bk-1"); // request + ledger share the key
    expect(params.p_via).toBe("desk");
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_person).toBe(PERSON_ID);
    expect(params.p_session).toBe(SESSION_ID);
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_hold).toBe(HOLD_ID);
    expect(params.p_use_credit).toBe(true);
  });

  it("is idempotent: a repeated POST replays the stored response and books ONCE", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const send = () =>
      app.request(
        "/api/v1/bookings",
        post("/bookings", { session_id: SESSION_ID, person_id: PERSON_ID }, { "idempotency-key": "bk-dup" }),
      );
    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("true");
    // The booking RPC (the sole ledger writer) ran exactly once across both.
    expect(fake.calls.filter((c) => c.table === "book_session")).toHaveLength(1);
  });

  it("maps the waiver enforcer's 42501 waiver_required to 403 booking_waiver_required", async () => {
    const fake = userFake("owner", {
      ...defaultRpc,
      book_session: () => ({ data: null, error: { code: "42501", message: "waiver_required" } }),
    });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/bookings",
      post("/bookings", { session_id: SESSION_ID, person_id: PERSON_ID }, { "idempotency-key": "bk-w" }),
    );
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("booking_waiver_required");
  });

  it("maps the no-oversell 23514 to 409 session_at_capacity", async () => {
    const fake = userFake("owner", {
      ...defaultRpc,
      book_session: () => ({ data: null, error: { code: "23514", message: "session is at capacity" } }),
    });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/bookings",
      post("/bookings", { session_id: SESSION_ID, person_id: PERSON_ID }, { "idempotency-key": "bk-c" }),
    );
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("session_at_capacity");
  });

  it("403s a trainer before the RPC", async () => {
    const fake = userFake("trainer");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/bookings",
      post("/bookings", { session_id: SESSION_ID, person_id: PERSON_ID }),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "book_session")).toBe(false);
  });
});

// -- POST /bookings/:id/cancel --------------------------------------------------

describe("POST /bookings/:id/cancel — cancel with the refund/forfeit policy", () => {
  it("threads the booking id + key + now into cancel_booking and returns the branch", async () => {
    const fake = userFake("manager");
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${BOOKING_ID}/cancel`,
      post(`/bookings/${BOOKING_ID}/cancel`, {}, { "idempotency-key": "cx-1" }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { cancellation: { branch: string; refunded: boolean } } };
    expect(payload.data.cancellation.branch).toBe("refund");
    expect(payload.data.cancellation.refunded).toBe(true);

    const rpc = fake.calls.find((c) => c.table === "cancel_booking");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_booking).toBe(BOOKING_ID);
    expect(params.p_idempotency_key).toBe("cx-1");
    expect(params.p_actor).toBe(USER_ID);
    expect(typeof params.p_now).toBe("string");
  });

  it("passes a forfeit branch through verbatim", async () => {
    const fake = userFake("owner", {
      ...defaultRpc,
      cancel_booking: () => ({
        data: { booking_id: BOOKING_ID, status: "cancelled", branch: "forfeit", refunded: false },
      }),
    });
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${BOOKING_ID}/cancel`,
      post(`/bookings/${BOOKING_ID}/cancel`, {}, { "idempotency-key": "cx-2" }),
    );
    const payload = (await res.json()) as { data: { cancellation: { branch: string; refunded: boolean } } };
    expect(payload.data.cancellation.branch).toBe("forfeit");
    expect(payload.data.cancellation.refunded).toBe(false);
  });

  it("403s a trainer before the RPC", async () => {
    const fake = userFake("trainer");
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${BOOKING_ID}/cancel`,
      post(`/bookings/${BOOKING_ID}/cancel`, {}),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "cancel_booking")).toBe(false);
  });
});

// -- POST /bookings/:id/freeze-hold ---------------------------------------------

describe("POST /bookings/:id/freeze-hold — freeze a hold's expiry", () => {
  it("threads the hold id into freeze_hold", async () => {
    const fake = userFake("front_desk");
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${HOLD_ID}/freeze-hold`,
      post(`/bookings/${HOLD_ID}/freeze-hold`, {}),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { hold: { id: string; frozen: boolean } } };
    expect(payload.data.hold.id).toBe(HOLD_ID);
    expect(payload.data.hold.frozen).toBe(true);

    const rpc = fake.calls.find((c) => c.table === "freeze_hold");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_hold).toBe(HOLD_ID);
    expect(params.p_tenant).toBe(TENANT_A);
  });

  it("403s a trainer before the RPC", async () => {
    const fake = userFake("trainer");
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${HOLD_ID}/freeze-hold`,
      post(`/bookings/${HOLD_ID}/freeze-hold`, {}),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "freeze_hold")).toBe(false);
  });
});

// -- POST /bookings/:id/release-hold --------------------------------------------
// REVIEW FIX 6.1-crit-2: the operator remediation for an abandoned tender. The
// RPC deletes REGARDLESS of frozen (asserted structurally in
// bookings-migration.test.ts); here we pin the route contract.

describe("POST /bookings/:id/release-hold — operator hold release", () => {
  it("threads hold + actor into release_hold and reports the deletion", async () => {
    const fake = userFake("front_desk");
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${HOLD_ID}/release-hold`,
      post(`/bookings/${HOLD_ID}/release-hold`, {}),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { hold: { id: string; released: boolean } } };
    expect(payload.data.hold.id).toBe(HOLD_ID);
    expect(payload.data.hold.released).toBe(true);

    const rpc = fake.calls.find((c) => c.table === "release_hold");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_hold).toBe(HOLD_ID);
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_actor).toBe(USER_ID);
  });

  it("403s a trainer before the RPC", async () => {
    const fake = userFake("trainer");
    const { app } = appFor(fake);
    const res = await app.request(
      `/api/v1/bookings/${HOLD_ID}/release-hold`,
      post(`/bookings/${HOLD_ID}/release-hold`, {}),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "release_hold")).toBe(false);
  });
});
