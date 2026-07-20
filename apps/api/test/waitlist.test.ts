import { describe, expect, it } from "vitest";
import type { KeloSupabaseClient } from "@kelo/db";
import { createApp } from "../src/app.js";
import { IDEMPOTENT_REPLAY_HEADER } from "../src/middleware/mutation.js";
import { fakeUserClient, TENANT_A, USER_ID, type RecordedCall, type RpcHandler } from "./fakes.js";

/**
 * Phase 6 · unit 6.2 — the booking desk waitlist routes (join / accept / decline
 * / position / check-in / roster). Every mutation runs requireAuth →
 * resolveTenant → requireRole(owner/manager/front_desk) → persistIdempotency →
 * a definer RPC (invariant #5: no client booking write, no optimistic UI). These
 * pin the role gate, the Idempotency-Key 422, the replay, and the data-booking.ts
 * RPC-error → HTTP mapping (incl. accept's book_session waiver block → 403).
 */

const NOW = "2026-07-18T12:00:00.000Z";
const SESSION_ID = "6c000000-0000-4000-8000-000000000001";
const PERSON_ID = "6c000000-0000-4000-8000-000000000002";
const ENTRY_ID = "6c000000-0000-4000-8000-000000000003";
const BOOKING_ID = "6c000000-0000-4000-8000-000000000004";

function tenantRow() {
  return { id: TENANT_A, name: "Tenant A", slug: "tenant-a", settings: {}, status: "active", created_at: NOW, updated_at: NOW };
}

// Stateful idempotency_keys fake for the BILLING client persistIdempotency uses.
interface IdemRow { tenant_id: string; key: string; request_hash: string; response_status: number | null; response_body: unknown }
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
        store.set(id, { tenant_id: String(values.tenant_id), key: String(values.key), request_hash: String(values.request_hash), response_status: null, response_body: null });
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
      return { data: [...store.values()].filter(matches).map((r) => ({ request_hash: r.request_hash, response_status: r.response_status, response_body: r.response_body })), error: null };
    }
    const api: Record<string, unknown> = {
      select() { if (op !== "insert") op = "select"; return api; },
      insert(v: Record<string, unknown>) { op = "insert"; values = v; return api; },
      update(v: Record<string, unknown>) { op = "update"; values = v; return api; },
      delete() { op = "delete"; return api; },
      eq(col: string, val: unknown) { filters.push({ col, val }); return api; },
      is(col: string, val: unknown) { filters.push({ col, val }); return api; },
      limit() { return api; },
      then(resolve: (r: unknown) => void) { resolve(execute()); },
    };
    return api;
  }
  return { client: { from: () => builder() } as unknown as KeloSupabaseClient };
}

const defaultRpc: Record<string, RpcHandler> = {
  join_waitlist: () => ({ data: 3 }),
  accept_waitlist_offer: () => ({ data: BOOKING_ID }),
  decline_waitlist_offer: () => ({ data: null }),
  check_in: () => ({ data: "checked_in" }),
  waitlist_position: () => ({ data: [{ position: 2, total_waiting: 5, offer_expires_at: null, status: "waiting" }] }),
};

function userFake(opts: { role: string; rpc?: Record<string, RpcHandler> }) {
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: opts.role }] }),
      tenants: () => ({ data: [tenantRow()] }),
      bookings: () => ({ data: [{ id: BOOKING_ID, person_id: PERSON_ID, status: "booked", checked_in_at: null, people: { first_name: "Ada" } }] }),
      waitlist_entries: () => ({ data: [{ id: ENTRY_ID, person_id: PERSON_ID, position: 1, status: "waiting", offer_expires_at: null, people: { first_name: "Ada" } }] }),
    },
    { ...defaultRpc, ...opts.rpc },
  );
}

function appFor(fake: ReturnType<typeof fakeUserClient>, billing = makeBillingClient()) {
  const app = createApp({ verifyAccessToken: async () => ({ userId: USER_ID }), createUserClient: () => fake.client, createBillingClient: () => billing.client });
  return { app, fake };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": "wl-1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) };
}
const get = { headers: { authorization: "Bearer t" } };

describe("POST /waitlist/join", () => {
  it("threads tenant/actor/session/person + the Idempotency-Key into join_waitlist → 201 position", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/waitlist/join", post({ session_id: SESSION_ID, person_id: PERSON_ID }, { "idempotency-key": "wl-J" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { waitlist: { position: number } } }).data.waitlist.position).toBe(3);
    const rpc = fake.calls.find((c) => c.table === "join_waitlist");
    const p = rpc?.args[0] as Record<string, unknown>;
    expect(p.p_tenant).toBe(TENANT_A);
    expect(p.p_actor).toBe(USER_ID);
    expect(p.p_session).toBe(SESSION_ID);
    expect(p.p_person).toBe(PERSON_ID);
    expect(p.p_idempotency_key).toBe("wl-J");
  });

  it("422 without an Idempotency-Key (RPC never called)", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/waitlist/join", post({ session_id: SESSION_ID, person_id: PERSON_ID }, { "idempotency-key": "" }));
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "join_waitlist")).toBe(false);
  });

  it("403 for a role outside owner/manager/front_desk before the RPC", async () => {
    const fake = userFake({ role: "trainer" });
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/waitlist/join", post({ session_id: SESSION_ID, person_id: PERSON_ID }));
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "join_waitlist")).toBe(false);
  });
});

describe("POST /waitlist/:id/accept", () => {
  it("books through accept_waitlist_offer and returns the booking (201)", async () => {
    const fake = userFake({ role: "manager" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/waitlist/${ENTRY_ID}/accept`, post(undefined, { "idempotency-key": "wl-A" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { booking: { booking_id: string } } }).data.booking.booking_id).toBe(BOOKING_ID);
    const rpc = fake.calls.find((c) => c.table === "accept_waitlist_offer");
    expect((rpc?.args[0] as Record<string, unknown>).p_idempotency_key).toBe("wl-A");
  });

  it("replays idempotently — the same key calls the booking RPC exactly once", async () => {
    const fake = userFake({ role: "manager" });
    const { app } = appFor(fake);
    const first = await app.request(`/api/v1/waitlist/${ENTRY_ID}/accept`, post(undefined, { "idempotency-key": "wl-R" }));
    expect(first.status).toBe(201);
    const second = await app.request(`/api/v1/waitlist/${ENTRY_ID}/accept`, post(undefined, { "idempotency-key": "wl-R" }));
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeTruthy();
    expect(fake.calls.filter((c: RecordedCall) => c.table === "accept_waitlist_offer")).toHaveLength(1);
  });

  it("maps the book_session error taxonomy: 42501 waiver/forbidden→403, 22023→422, P0002→404, 23505→409", async () => {
    const cases: { code: string; status: number; errCode: string }[] = [
      { code: "42501", status: 403, errCode: "booking_forbidden" },
      { code: "22023", status: 422, errCode: "booking_invalid" },
      { code: "P0002", status: 404, errCode: "booking_target_not_found" },
      { code: "23505", status: 409, errCode: "idempotency_key_conflict" },
    ];
    for (const [i, tc] of cases.entries()) {
      const fake = userFake({ role: "manager", rpc: { accept_waitlist_offer: () => ({ error: { code: tc.code, message: "x" } }) } });
      const { app } = appFor(fake);
      const res = await app.request(`/api/v1/waitlist/${ENTRY_ID}/accept`, post(undefined, { "idempotency-key": `wl-e${i}` }));
      expect(res.status, tc.code).toBe(tc.status);
      expect(((await res.json()) as { error: { code: string } }).error.code, tc.code).toBe(tc.errCode);
    }
  });
});

describe("POST /waitlist/:id/decline", () => {
  it("releases the offer → 200 { declined: true }", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/waitlist/${ENTRY_ID}/decline`, post(undefined, { "idempotency-key": "wl-D" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { declined: boolean } }).data.declined).toBe(true);
    expect(fake.calls.some((c) => c.table === "decline_waitlist_offer")).toBe(true);
  });
});

describe("GET /waitlist/position + POST /bookings/:id/check-in + GET /sessions/:id/roster", () => {
  it("position returns the member's true FIFO position + offer window", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/waitlist/position?session_id=${SESSION_ID}&person_id=${PERSON_ID}`, get);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { position: { position: number; total_waiting: number } } }).data.position.position).toBe(2);
  });

  it("check-in → 200 { check_in: { status: 'checked_in' } }", async () => {
    const fake = userFake({ role: "front_desk" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/bookings/${BOOKING_ID}/check-in`, post(undefined, { "idempotency-key": "wl-C" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { check_in: { status: string } } }).data.check_in.status).toBe("checked_in");
  });

  it("roster returns the session's active bookings + live waitlist (names under RLS)", async () => {
    const fake = userFake({ role: "manager" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/sessions/${SESSION_ID}/roster`, get);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { roster: { bookings: unknown[]; waitlist: unknown[] } } };
    expect(body.data.roster.bookings).toHaveLength(1);
    expect(body.data.roster.waitlist).toHaveLength(1);
  });

  it("403 for a role outside the allowed set on the reads", async () => {
    const fake = userFake({ role: "trainer" });
    const { app } = appFor(fake);
    const res = await app.request(`/api/v1/sessions/${SESSION_ID}/roster`, get);
    expect(res.status).toBe(403);
  });
});
