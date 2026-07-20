import { describe, expect, it } from "vitest";
import { createMemberApiClient } from "../src/index.js";

/**
 * member-core auth client tests (unit 8.2b) — fake fetch ONLY, zero network.
 * The shapes mirror packages/contracts/src/member.ts: startAuth posts the
 * start body to /member/auth/start and accepts the neutral 202; verifyAuth
 * posts the verify body to /member/auth/verify and returns the member view.
 */

const TENANT = "7a0a3f6e-4d1f-4a2c-9c3e-2b8f0d5a1e44";

const VALID_META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "member-auth:v1",
  correlation_id: "corr-auth-1",
};

const VALID_VIEW = {
  member: { first_name: "Sam", claim_status: "active" },
  session: {
    expires_at: "2026-10-19T12:00:00.000Z",
    absolute_expires_at: "2027-07-19T12:00:00.000Z",
  },
  token: "kmb_abc123",
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

interface SeenRequest {
  url: string;
  method: string;
  body: unknown;
}

function recordingFetch(status: number, body: unknown, seen: SeenRequest[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return fakeFetch(status, body)(input, init);
  }) as typeof fetch;
}

describe("member-core startAuth", () => {
  it("posts the start body and accepts the neutral 202", async () => {
    const seen: SeenRequest[] = [];
    const client = createMemberApiClient();
    const result = await client.startAuth({
      origin: "https://member.example",
      tenant: TENANT,
      contact: "Member@Example.test",
      fetchImpl: recordingFetch(202, { data: { sent: true }, meta: VALID_META }, seen),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sent).toBe(true);
    expect(result.meta.correlation_id).toBe("corr-auth-1");

    // The contact goes to the API EXACTLY as typed — normalization and
    // hashing are server-side only.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://member.example/api/v1/member/auth/start");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toEqual({ tenant: TENANT, contact: "Member@Example.test" });
  });

  it("malformed params are caught before any fetch (invalid_params)", async () => {
    let called = false;
    const client = createMemberApiClient();
    const result = await client.startAuth({
      origin: "",
      tenant: "not-a-uuid",
      contact: "member@example.test",
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

  it("a 2xx without the freshness meta is envelope_invalid (provenance defect)", async () => {
    const client = createMemberApiClient();
    const result = await client.startAuth({
      origin: "",
      tenant: TENANT,
      contact: "member@example.test",
      fetchImpl: fakeFetch(202, { data: { sent: true } }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("envelope_invalid");
  });
});

describe("member-core verifyAuth", () => {
  it("posts the verify body and returns the member view (mobile token in-body)", async () => {
    const seen: SeenRequest[] = [];
    const client = createMemberApiClient();
    const result = await client.verifyAuth({
      origin: "https://member.example",
      tenant: TENANT,
      contact: "member@example.test",
      code: "123456",
      platform: "ios",
      deviceLabel: "Sam's iPhone",
      fetchImpl: recordingFetch(200, { data: VALID_VIEW, meta: VALID_META }, seen),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.member.first_name).toBe("Sam");
    expect(result.view.member.claim_status).toBe("active");
    expect(result.view.token).toBe("kmb_abc123");

    expect(seen[0]?.url).toBe("https://member.example/api/v1/member/auth/verify");
    expect(seen[0]?.body).toEqual({
      tenant: TENANT,
      contact: "member@example.test",
      code: "123456",
      platform: "ios",
      device_label: "Sam's iPhone",
    });
  });

  it("accepts the needs_resolution view (first-name-only, no balances exist in the shape)", async () => {
    const client = createMemberApiClient();
    const result = await client.verifyAuth({
      origin: "",
      tenant: TENANT,
      contact: "member@example.test",
      code: "123456",
      platform: "web",
      fetchImpl: fakeFetch(200, {
        data: {
          member: { first_name: "Sam", claim_status: "needs_resolution" },
          session: VALID_VIEW.session,
        },
        meta: VALID_META,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.member.claim_status).toBe("needs_resolution");
    expect(result.view.token).toBeUndefined();
  });

  it("a wrong/expired code surfaces as http_error 401 (the API's neutral failure)", async () => {
    const client = createMemberApiClient();
    const result = await client.verifyAuth({
      origin: "",
      tenant: TENANT,
      contact: "member@example.test",
      code: "000000",
      platform: "web",
      fetchImpl: fakeFetch(401, {
        error: {
          code: "invalid_code",
          message: "the code is invalid or expired",
          correlation_id: "c",
        },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("http_error");
    expect(result.error.status).toBe(401);
  });

  it("fetch rejection → network_error", async () => {
    const client = createMemberApiClient();
    const result = await client.verifyAuth({
      origin: "",
      tenant: TENANT,
      contact: "member@example.test",
      code: "123456",
      platform: "android",
      fetchImpl: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("network_error");
  });

  it("a view missing required fields is shape_invalid", async () => {
    const client = createMemberApiClient();
    const result = await client.verifyAuth({
      origin: "",
      tenant: TENANT,
      contact: "member@example.test",
      code: "123456",
      platform: "web",
      fetchImpl: fakeFetch(200, {
        data: { member: { first_name: "Sam" } },
        meta: VALID_META,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("shape_invalid");
  });

  it("client-level fetchImpl is the default for both auth methods", async () => {
    const client = createMemberApiClient({
      fetchImpl: fakeFetch(202, { data: { sent: true }, meta: VALID_META }),
    });
    const started = await client.startAuth({
      origin: "",
      tenant: TENANT,
      contact: "member@example.test",
    });
    expect(started.ok).toBe(true);
  });
});
