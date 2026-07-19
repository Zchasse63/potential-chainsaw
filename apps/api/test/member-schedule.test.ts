import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult } from "./fakes.js";

/**
 * Unit 8.1c — GET /api/v1/member/schedule, the ANONYMOUS public schedule the
 * member web app's SSR page renders (plan-member-app §3.5). No auth header is
 * ever sent; the tenant arrives as a PUBLIC uuid query param. The route rides
 * public.member_schedule (migration 0043), whose locked SECURITY DEFINER
 * return shape is the security boundary; the route's Zod response parse is
 * the second, independent strip — even a misbehaving RPC cannot leak an
 * attendee column through this endpoint.
 */

const FROM = "2026-07-20T00:00:00Z";
const TO = "2026-07-27T00:00:00Z";
const GOOD = { tenant: TENANT_A, from: FROM, to: TO };

const ROW = {
  session_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  offering_name: "Flow",
  starts_at: "2026-07-21T14:00:00+00:00",
  ends_at: "2026-07-21T15:00:00+00:00",
  capacity: 12,
  available: 11,
  readiness_ok: true,
  credit_cost: 1,
};

const ALLOWLIST_KEYS = [
  "available",
  "capacity",
  "credit_cost",
  "ends_at",
  "offering_name",
  "readiness_ok",
  "session_id",
  "starts_at",
];

function scheduleApp(rpcResult: FakeResult) {
  const fake = fakeUserClient({}, { member_schedule: () => rpcResult });
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

function url(query: Record<string, string>): string {
  return `/api/v1/member/schedule?${new URLSearchParams(query).toString()}`;
}

describe("GET /api/v1/member/schedule (anonymous)", () => {
  it("serves the published schedule anonymously inside the freshness envelope", async () => {
    const { app, fake } = scheduleApp({ data: [ROW] });
    // NO Authorization header, NO tenant header — this route is public.
    const res = await app.request(url(GOOD));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The freshness envelope (invariant #3), source native, pinned definition.
    expect(body.meta.source).toBe("native");
    expect(body.meta.stale).toBe(false);
    expect(body.meta.definition_version).toBe("member-schedule:v1");
    expect(typeof body.meta.as_of).toBe("string");
    expect(typeof body.meta.correlation_id).toBe("string");
    expect(body.data).toEqual([ROW]);

    // The RPC is called with exactly the three validated params.
    const rpc = fake.calls.find((call) => call.method === "rpc");
    expect(rpc?.table).toBe("member_schedule");
    expect(rpc?.args[0]).toEqual({ p_tenant: TENANT_A, p_from: FROM, p_to: TO });
  });

  it("returns ONLY the 8 allowlist fields — a stray attendee column is stripped", async () => {
    const { app } = scheduleApp({
      data: [
        {
          ...ROW,
          person_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          attendee_email: "member@example.test",
        },
      ],
    });
    const res = await app.request(url(GOOD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.data[0]).sort()).toEqual(ALLOWLIST_KEYS);
  });

  it("reports the fixed v1 cost model: credit_cost is the integer 1", async () => {
    const { app } = scheduleApp({ data: [ROW] });
    const res = await app.request(url(GOOD));
    const body = await res.json();
    expect(body.data[0].credit_cost).toBe(1);
  });

  it("serves an empty window as a 200 with an empty array", async () => {
    const { app } = scheduleApp({ data: [] });
    const res = await app.request(url(GOOD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it("accepts a window of exactly 45 days (the abuse bound is exclusive)", async () => {
    const { app } = scheduleApp({ data: [] });
    const res = await app.request(
      url({ tenant: TENANT_A, from: "2026-07-01T00:00:00Z", to: "2026-08-15T00:00:00Z" }),
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["missing tenant", { from: FROM, to: TO }],
    ["tenant is not a uuid", { tenant: "the-sauna-guys", from: FROM, to: TO }],
    ["from is not an ISO instant", { tenant: TENANT_A, from: "next week", to: TO }],
    ["missing to", { tenant: TENANT_A, from: FROM }],
    ["to is not after from", { tenant: TENANT_A, from: TO, to: FROM }],
    [
      "window longer than 45 days",
      { tenant: TENANT_A, from: "2026-07-01T00:00:00Z", to: "2026-08-20T00:00:00Z" },
    ],
  ])("rejects with 422: %s", async (_label, query) => {
    const { app, fake } = scheduleApp({ data: [ROW] });
    const res = await app.request(url(query));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
    // A rejected request NEVER reaches the database.
    expect(fake.calls.filter((call) => call.method === "rpc")).toHaveLength(0);
  });

  it("maps an RPC failure to a structured 500 — never 200-with-failure", async () => {
    const { app } = scheduleApp({ data: null, error: { message: "connection reset" } });
    const res = await app.request(url(GOOD));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("schedule_read_failed");
    expect(body.error.message).not.toContain("connection reset");
  });
});
