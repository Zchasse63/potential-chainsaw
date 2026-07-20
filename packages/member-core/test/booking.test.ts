import { describe, expect, it } from "vitest";
import { holdSeat, bookSeat, cancelBooking, joinWaitlist, fetchAccount } from "../src/index.js";

/**
 * member-core booking client (units 8.3a/8.3b) — fake fetch ONLY, zero network.
 * Mirrors the member API: session-scoped POSTs carry the money-mutation
 * Idempotency-Key; mobile passes the token as Bearer, web rides the cookie.
 */

const ORIGIN = "https://member.example";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOKING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const META = {
  as_of: "2026-07-20T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "member-booking:v1",
  correlation_id: "corr-1",
};

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function capturingFetch(data: unknown): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body != null ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: META }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("holdSeat", () => {
  it("POSTs /member/holds with session_id + platform and returns the hold", async () => {
    const { fetchImpl, seen } = capturingFetch({ hold: { id: HOLD, expires_at: null, frozen: false } });
    const res = await holdSeat({ origin: ORIGIN, sessionId: SESSION, fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.id).toBe(HOLD);
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/v1/member/holds`);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toEqual({ session_id: SESSION, platform: "web" });
    // Web: no Authorization header (the cookie carries the session).
    expect(seen[0]?.headers.get("authorization")).toBeNull();
  });
});

describe("bookSeat", () => {
  it("POSTs /member/bookings with the Idempotency-Key + hold_id, returns the booking", async () => {
    const { fetchImpl, seen } = capturingFetch({ booking: { booking_id: BOOKING } });
    const res = await bookSeat({
      origin: ORIGIN,
      sessionId: SESSION,
      holdId: HOLD,
      idempotencyKey: "intent-1",
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.booking_id).toBe(BOOKING);
    expect(seen[0]?.headers.get("idempotency-key")).toBe("intent-1");
    expect(seen[0]?.body).toEqual({ session_id: SESSION, platform: "web", hold_id: HOLD });
  });

  it("mobile: attaches the session token as Authorization: Bearer", async () => {
    const { fetchImpl, seen } = capturingFetch({ booking: { booking_id: BOOKING } });
    await bookSeat({
      origin: ORIGIN,
      sessionId: SESSION,
      idempotencyKey: "intent-2",
      token: "kmb_mobiletoken",
      platform: "ios",
      fetchImpl,
    });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer kmb_mobiletoken");
    expect(seen[0]?.body).toMatchObject({ platform: "ios" });
  });
});

describe("cancelBooking", () => {
  it("POSTs /member/bookings/:id/cancel with the Idempotency-Key", async () => {
    const { fetchImpl, seen } = capturingFetch({
      cancellation: { booking_id: BOOKING, status: "cancelled", branch: "refund", refunded: true },
    });
    const res = await cancelBooking({ origin: ORIGIN, bookingId: BOOKING, idempotencyKey: "x", fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.branch).toBe("refund");
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/v1/member/bookings/${BOOKING}/cancel`);
    expect(seen[0]?.headers.get("idempotency-key")).toBe("x");
  });
});

describe("joinWaitlist", () => {
  it("returns the FIFO position", async () => {
    const { fetchImpl } = capturingFetch({ waitlist: { position: 3 } });
    const res = await joinWaitlist({ origin: ORIGIN, sessionId: SESSION, idempotencyKey: "w", fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.position).toBe(3);
  });
});

describe("fetchAccount", () => {
  it("GETs /member/account and returns balance + waiver + bookings", async () => {
    const { fetchImpl, seen } = capturingFetch({
      credit_balance: 7,
      waiver: { needs_signature: false },
      bookings: [{ booking_id: BOOKING, session_id: SESSION, status: "booked" }],
    });
    const res = await fetchAccount({ origin: ORIGIN, fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.credit_balance).toBe(7);
      expect(res.value.bookings).toHaveLength(1);
    }
    expect(seen[0]?.method).toBe("GET");
  });

  it("rejects a 2xx WITHOUT the freshness envelope (provenance-or-nothing)", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ credit_balance: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    const res = await fetchAccount({ origin: ORIGIN, fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("envelope_invalid");
  });
});
