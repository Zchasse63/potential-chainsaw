import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";
import { MEMBER_COOKIE } from "../src/middleware/member.js";

/**
 * Unit 8.3a — member booking API (hold / book / cancel / waitlist). Every route
 * is person-scoped from resolveMember; the phase-6 RPCs do the money/waiver/
 * capacity work. The security-critical route logic here is: person + actor come
 * ONLY from the session (a member acts only for themselves), the hold-DoS cap,
 * and the cancel OWNERSHIP check (cancel_booking has operator semantics).
 */

const TOKEN = "kmb_testtoken0000000000000000000000000000000000a";
const PERSON_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_PERSON = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SESSION_ID = "99999999-9999-4999-8999-999999999999";
const BOOKING_ID = "77777777-7777-4777-8777-777777777777";
const HOLD_ID = "66666666-6666-4666-8666-666666666666";
const FUTURE = "2099-01-01T00:00:00Z";

function bookingApp(scenario: { liveHolds?: number; bookingOwner?: string | null } = {}) {
  const fake = fakeUserClient(
    {
      member_sessions: (calls: RecordedCall[]): FakeResult => {
        if (calls.some((c) => c.method === "update")) return { data: null };
        return {
          data: [
            {
              id: SESSION_ID,
              tenant_id: TENANT_A,
              person_id: PERSON_ID,
              expires_at: FUTURE,
              absolute_expires_at: FUTURE,
              revoked_at: null,
              step_up_at: null,
            },
          ],
        };
      },
      person_claims: (): FakeResult => ({ data: [{ status: "active" }] }),
      booking_holds: (): FakeResult => ({
        data: Array.from({ length: scenario.liveHolds ?? 0 }, () => ({
          expires_at: FUTURE,
          frozen: false,
        })),
      }),
      bookings: (): FakeResult => ({
        data:
          scenario.bookingOwner === null
            ? []
            : [{ person_id: scenario.bookingOwner ?? PERSON_ID }],
      }),
    },
    {
      hold_session: () => ({ data: HOLD_ID }),
      book_session: () => ({
        data: { booking_id: BOOKING_ID, credit_entry_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      }),
      cancel_booking: () => ({
        data: { booking_id: BOOKING_ID, status: "cancelled", branch: "refund", refunded: true },
      }),
      join_waitlist: () => ({ data: 3 }),
    },
  );
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

const auth = { cookie: `${MEMBER_COOKIE}=${TOKEN}`, "content-type": "application/json", "idempotency-key": "idem-1" };
const post = (body: unknown, headers = auth) => ({ method: "POST", headers, body: JSON.stringify(body) });

describe("POST /member/holds", () => {
  it("reserves a seat for the SESSION's person (never a request-supplied one)", async () => {
    const { app, fake } = bookingApp();
    const res = await app.request("/api/v1/member/holds", post({ session_id: BOOKING_ID, tenant: "x", person_id: OTHER_PERSON }));
    expect(res.status).toBe(201);
    const rpc = fake.calls.find((c) => c.table === "hold_session");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_person).toBe(PERSON_ID); // session person, NOT the injected OTHER_PERSON
    expect(params.p_actor).toBe(PERSON_ID);
    expect(params.p_tenant).toBe(TENANT_A);
  });

  it("enforces the hold-DoS cap: a 3rd live hold is refused (409), no RPC", async () => {
    const { app, fake } = bookingApp({ liveHolds: 2 });
    const res = await app.request("/api/v1/member/holds", post({ session_id: BOOKING_ID }));
    expect(res.status).toBe(409);
    expect(fake.calls.some((c) => c.table === "hold_session")).toBe(false);
  });

  it("401s without a session", async () => {
    const { app } = bookingApp();
    const res = await app.request("/api/v1/member/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: BOOKING_ID }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /member/bookings", () => {
  it("books for the session's person, member_web channel, threading the idempotency key", async () => {
    const { app, fake } = bookingApp();
    const res = await app.request("/api/v1/member/bookings", post({ session_id: BOOKING_ID, hold_id: HOLD_ID }));
    expect(res.status).toBe(201);
    const rpc = fake.calls.find((c) => c.table === "book_session");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_person).toBe(PERSON_ID);
    expect(params.p_actor).toBe(PERSON_ID);
    expect(params.p_via).toBe("member_web");
    expect(params.p_use_credit).toBe(true);
    expect(params.p_idempotency_key).toBe("idem-1");
  });

  it("422s without an Idempotency-Key (money safety)", async () => {
    const { app } = bookingApp();
    const res = await app.request("/api/v1/member/bookings", post({ session_id: BOOKING_ID }, { cookie: `${MEMBER_COOKIE}=${TOKEN}`, "content-type": "application/json" }));
    expect(res.status).toBe(422);
  });
});

describe("POST /member/bookings/:id/cancel — OWNERSHIP", () => {
  it("cancels the member's OWN booking", async () => {
    const { app, fake } = bookingApp({ bookingOwner: PERSON_ID });
    const res = await app.request(`/api/v1/member/bookings/${BOOKING_ID}/cancel`, post({}));
    expect(res.status).toBe(200);
    expect(fake.calls.some((c) => c.table === "cancel_booking")).toBe(true);
  });

  it("REFUSES to cancel ANOTHER member's booking (404, cancel_booking never called)", async () => {
    const { app, fake } = bookingApp({ bookingOwner: OTHER_PERSON });
    const res = await app.request(`/api/v1/member/bookings/${BOOKING_ID}/cancel`, post({}));
    expect(res.status).toBe(404);
    // The ownership check fired BEFORE the RPC — no refund/forfeit of a stranger's seat.
    expect(fake.calls.some((c) => c.table === "cancel_booking")).toBe(false);
  });

  it("404s a non-existent booking id (same neutral shape)", async () => {
    const { app } = bookingApp({ bookingOwner: null });
    const res = await app.request(`/api/v1/member/bookings/${BOOKING_ID}/cancel`, post({}));
    expect(res.status).toBe(404);
  });
});

describe("POST /member/waitlist", () => {
  it("joins for the session's person and returns the FIFO position", async () => {
    const { app, fake } = bookingApp();
    const res = await app.request("/api/v1/member/waitlist", post({ session_id: BOOKING_ID }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { waitlist: { position: number } } };
    expect(body.data.waitlist.position).toBe(3);
    const rpc = fake.calls.find((c) => c.table === "join_waitlist");
    expect((rpc?.args[0] as Record<string, unknown>).p_person).toBe(PERSON_ID);
  });
});
