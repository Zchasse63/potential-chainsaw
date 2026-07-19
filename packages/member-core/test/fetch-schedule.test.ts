import { describe, expect, it } from "vitest";
import { createMemberApiClient } from "../src/index.js";

/**
 * fetchSchedule contract tests — fake fetch ONLY, zero network (the client
 * takes an injectable fetchImpl for exactly this). The shapes mirror
 * packages/contracts/src/member.ts + the envelope meta schema.
 */

const TENANT = "7a0a3f6e-4d1f-4a2c-9c3e-2b8f0d5a1e44";

const VALID_META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "member-schedule:v1",
  correlation_id: "corr-test-1",
};

const VALID_SESSION = {
  session_id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
  offering_name: "Sauna + Plunge",
  starts_at: "2026-07-20T07:30:00.000Z",
  ends_at: "2026-07-20T08:15:00.000Z",
  capacity: 8,
  available: 3,
  readiness_ok: true,
  credit_cost: 1,
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

const PARAMS = {
  origin: "https://member.example",
  tenant: TENANT,
  from: "2026-07-19T00:00:00.000Z",
  to: "2026-08-02T00:00:00.000Z",
};

describe("member-core fetchSchedule", () => {
  it("happy path: valid envelope → typed sessions + meta", async () => {
    let seenUrl: string | undefined;
    const fetchImpl = ((input: RequestInfo | URL) => {
      seenUrl = String(input);
      return fakeFetch(200, { data: [VALID_SESSION], meta: VALID_META })(input);
    }) as typeof fetch;

    const client = createMemberApiClient();
    const result = await client.fetchSchedule({ ...PARAMS, fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      session_id: VALID_SESSION.session_id,
      offering_name: "Sauna + Plunge",
      available: 3,
      credit_cost: 1,
    });
    expect(result.meta.correlation_id).toBe("corr-test-1");
    // The request hits the one Hono API route with the pinned tenant + window.
    expect(seenUrl).toBe(
      `https://member.example/api/v1/member/schedule?tenant=${TENANT}` +
        `&from=${encodeURIComponent(PARAMS.from)}&to=${encodeURIComponent(PARAMS.to)}`,
    );
  });

  it("envelope missing meta → ok:false envelope_invalid (provenance defect)", async () => {
    const client = createMemberApiClient();
    const result = await client.fetchSchedule({
      ...PARAMS,
      fetchImpl: fakeFetch(200, { data: [VALID_SESSION] }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("envelope_invalid");
  });

  it("HTTP error → ok:false http_error carrying the status", async () => {
    const client = createMemberApiClient();
    const result = await client.fetchSchedule({
      ...PARAMS,
      fetchImpl: fakeFetch(500, {
        error: { code: "schedule_read_failed", message: "x", correlation_id: "c" },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("http_error");
    expect(result.error.status).toBe(500);
  });

  it("bad-shape data → ok:false shape_invalid", async () => {
    const client = createMemberApiClient();
    const result = await client.fetchSchedule({
      ...PARAMS,
      fetchImpl: fakeFetch(200, {
        // capacity as a STRING breaks memberScheduleItemSchema.
        data: [{ ...VALID_SESSION, capacity: "8" }],
        meta: VALID_META,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("shape_invalid");
  });

  it("fetch rejection → ok:false network_error", async () => {
    const client = createMemberApiClient();
    const result = await client.fetchSchedule({
      ...PARAMS,
      fetchImpl: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("network_error");
  });

  it("malformed params are caught before any fetch (invalid_params)", async () => {
    let called = false;
    const client = createMemberApiClient();
    const result = await client.fetchSchedule({
      ...PARAMS,
      tenant: "not-a-uuid",
      fetchImpl: (() => {
        called = true;
        return Promise.resolve(new Response("{}"));
      }) as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_params");
    expect(called).toBe(false);
  });

  it("client-level fetchImpl is the default; per-call wins", async () => {
    const clientFetch = fakeFetch(200, { data: [], meta: VALID_META });
    const client = createMemberApiClient({ fetchImpl: clientFetch });

    const fromClient = await client.fetchSchedule(PARAMS);
    expect(fromClient.ok).toBe(true);

    const perCall = await client.fetchSchedule({
      ...PARAMS,
      fetchImpl: fakeFetch(503, "nope"),
    });
    expect(perCall.ok).toBe(false);
    if (perCall.ok) return;
    expect(perCall.error.status).toBe(503);
  });
});
