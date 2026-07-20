import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";
import { MEMBER_COOKIE } from "../src/middleware/member.js";

/**
 * Unit 8.3b — GET /member/account: the signed-in member's LIVE credit balance
 * (summed from the append-only ledger), waiver status, and active bookings.
 * Scope is the resolved session's person only.
 */

const TOKEN = "kmb_testtoken0000000000000000000000000000000000a";
const PERSON_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FUTURE = "2099-01-01T00:00:00Z";
const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function accountApp(scenario: {
  deltas?: number[];
  needsSignature?: boolean;
  bookings?: { id: string; session_id: string; status: string }[];
} = {}) {
  const fake = fakeUserClient(
    {
      member_sessions: (calls: RecordedCall[]): FakeResult => {
        if (calls.some((c) => c.method === "update")) return { data: null };
        return {
          data: [
            {
              id: "99999999-9999-4999-8999-999999999999",
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
      credit_ledger: (): FakeResult => ({
        data: (scenario.deltas ?? [5, -1]).map((delta) => ({ delta })),
      }),
      bookings: (): FakeResult => ({
        data:
          scenario.bookings ??
          [
            { id: B1, session_id: S1, status: "booked" },
            { id: B2, session_id: S1, status: "cancelled" },
          ],
      }),
    },
    {
      current_waiver_status: () => ({
        data: [{ needs_signature: scenario.needsSignature ?? false }],
      }),
    },
  );
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

const cookie = { headers: { cookie: `${MEMBER_COOKIE}=${TOKEN}` } };

describe("GET /member/account", () => {
  it("returns the LIVE credit balance (ledger sum), waiver status, and active bookings", async () => {
    const { app } = accountApp({ deltas: [10, -1, -1, 2], needsSignature: true });
    const res = await app.request("/api/v1/member/account", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        credit_balance: number;
        waiver: { needs_signature: boolean };
        bookings: { booking_id: string; status: string }[];
      };
    };
    // 10 - 1 - 1 + 2 = 10 (summed live from the append-only ledger).
    expect(body.data.credit_balance).toBe(10);
    expect(body.data.waiver.needs_signature).toBe(true);
    // Only the active booking; the cancelled one is filtered out.
    expect(body.data.bookings).toHaveLength(1);
    expect(body.data.bookings[0]?.booking_id).toBe(B1);
    expect(body.data.bookings[0]?.status).toBe("booked");
  });

  it("reads credit_ledger + bookings scoped to the session's person", async () => {
    const { app, fake } = accountApp();
    await app.request("/api/v1/member/account", cookie);
    for (const table of ["credit_ledger", "bookings"]) {
      const personEq = fake.calls.find(
        (c) => c.table === table && c.method === "eq" && c.args[0] === "person_id",
      );
      expect(personEq?.args[1], `${table} scoped to session person`).toBe(PERSON_ID);
    }
  });

  it("401s (neutral) without a session", async () => {
    const { app, fake } = accountApp();
    const res = await app.request("/api/v1/member/account");
    expect(res.status).toBe(401);
    expect(fake.calls.some((c) => c.table === "credit_ledger")).toBe(false);
  });
});
