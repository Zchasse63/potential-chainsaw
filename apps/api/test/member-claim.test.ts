import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";
import { MEMBER_COOKIE } from "../src/middleware/member.js";

/**
 * Unit 8.3c — GET /member/claim/status: the ONLY route a needs_resolution
 * session can reach (resolveMember allowUnresolved). It exposes its OWN claim
 * status + first name only; every other route still 403s a non-active claim.
 */

const TOKEN = "kmb_testtoken0000000000000000000000000000000000a";
const PERSON_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FUTURE = "2099-01-01T00:00:00Z";

function claimApp(claimStatus: string) {
  const fake = fakeUserClient({
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
    person_claims: (calls: RecordedCall[]): FakeResult => {
      // findPersonClaimStatus: the active-filtered query, then the latest query.
      const activeFiltered = calls.some((c) => c.method === "eq" && c.args[1] === "active");
      if (activeFiltered) {
        return { data: claimStatus === "active" ? [{ status: "active" }] : [] };
      }
      return { data: [{ status: claimStatus }] };
    },
    people: (): FakeResult => ({ data: [{ first_name: "Sam" }] }),
  });
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

const cookie = { headers: { cookie: `${MEMBER_COOKIE}=${TOKEN}` } };

describe("GET /member/claim/status", () => {
  it("lets a needs_resolution session read its OWN status + first name (no 403)", async () => {
    const { app } = claimApp("needs_resolution");
    const res = await app.request("/api/v1/member/claim/status", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { claim_status: string; first_name: string } };
    expect(body.data.claim_status).toBe("needs_resolution");
    expect(body.data.first_name).toBe("Sam");
    // No balances/bookings on the needs_resolution surface.
    expect(JSON.stringify(body.data)).not.toMatch(/balance|credit|booking/i);
  });

  it("returns active for a resolved session", async () => {
    const { app } = claimApp("active");
    const res = await app.request("/api/v1/member/claim/status", cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).data.claim_status).toBe("active");
  });

  it("a needs_resolution session is STILL 403'd from /member/me (allowUnresolved is scoped)", async () => {
    const { app } = claimApp("needs_resolution");
    const res = await app.request("/api/v1/member/me", cookie);
    expect(res.status).toBe(403);
  });

  it("401s without a session", async () => {
    const { app } = claimApp("needs_resolution");
    const res = await app.request("/api/v1/member/claim/status");
    expect(res.status).toBe(401);
  });
});
