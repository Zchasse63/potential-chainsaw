import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";
import { MEMBER_COOKIE } from "../src/middleware/member.js";

/**
 * Unit 8.2c — the resolveMember-gated session routes GET /member/me + POST
 * /member/auth/logout. Identity comes only from the session (memberOf); a
 * needs_resolution / absent claim never reaches these (resolveMember 403s).
 */

const TOKEN = "kmb_testtoken0000000000000000000000000000000000a";
const PERSON_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_ID = "99999999-9999-4999-8999-999999999999";
const FUTURE = "2099-01-01T00:00:00Z";

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    tenant_id: TENANT_A,
    person_id: PERSON_ID,
    expires_at: FUTURE,
    absolute_expires_at: FUTURE,
    revoked_at: null,
    step_up_at: null,
    ...overrides,
  };
}

interface Scenario {
  sessionRows?: unknown[];
  claimStatus?: string;
  firstName?: string | null;
}

function sessionApp(scenario: Scenario = {}) {
  const fake = fakeUserClient({
    member_sessions: (calls: RecordedCall[]): FakeResult => {
      if (calls.some((call) => call.method === "update")) return { data: null };
      return { data: scenario.sessionRows ?? [sessionRow()] };
    },
    person_claims: (calls: RecordedCall[]): FakeResult => {
      if (calls.some((call) => call.method === "eq" && call.args[1] === "active")) {
        return { data: scenario.claimStatus === "active" || scenario.claimStatus === undefined ? [{ status: "active" }] : [] };
      }
      return { data: [{ status: scenario.claimStatus ?? "active" }] };
    },
    people: (): FakeResult => ({ data: [{ first_name: scenario.firstName ?? "Sam" }] }),
    member_verification_events: (): FakeResult => ({ data: null }),
  });
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

const cookie = { headers: { cookie: `${MEMBER_COOKIE}=${TOKEN}` } };

const NEW_SESSION_ID = "88888888-8888-4888-8888-888888888888";

/** An app whose refresh_member_session RPC returns a fixed outcome. */
function refreshApp(outcome: {
  outcome: string;
  session_id?: string | null;
  expires_at?: string | null;
  absolute_expires_at?: string | null;
  platform?: string | null;
}) {
  const fake = fakeUserClient(
    {},
    {
      refresh_member_session: (params: Record<string, unknown>) => ({
        data: [
          {
            outcome: outcome.outcome,
            session_id: outcome.session_id ?? null,
            expires_at: outcome.expires_at ?? null,
            absolute_expires_at: outcome.absolute_expires_at ?? null,
            platform: outcome.platform ?? null,
            _params: params,
          },
        ],
      }),
    },
  );
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

describe("POST /member/auth/refresh — rotation + reuse-detection", () => {
  it("rotates a live web session: new cookie, old token never echoed, no token in body", async () => {
    const { app, fake } = refreshApp({
      outcome: "rotated",
      session_id: NEW_SESSION_ID,
      expires_at: FUTURE,
      absolute_expires_at: FUTURE,
      platform: "web",
    });
    const res = await app.request("/api/v1/member/auth/refresh", { method: "POST", ...cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { session: { expires_at: string }; token?: string } };
    expect(body.data.session.expires_at).toBe(FUTURE);
    expect(body.data.token).toBeUndefined(); // web rides the cookie

    // The RPC received only HASHES — never the raw kmb_ tokens.
    const rpc = fake.calls.find((call) => call.table === "refresh_member_session");
    const params = rpc?.args[0] as { p_token_hash: string; p_new_token_hash: string };
    expect(params.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(params.p_new_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(params)).not.toContain(TOKEN);
    expect(params.p_token_hash).not.toBe(params.p_new_token_hash);

    // A fresh kmb_ cookie is set; it is NOT the presented token.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`${MEMBER_COOKIE}=kmb_`));
    expect(setCookie).not.toContain(TOKEN);
  });

  it("rotates a mobile session: returns the new token in-body, no cookie", async () => {
    const { app } = refreshApp({
      outcome: "rotated",
      session_id: NEW_SESSION_ID,
      expires_at: FUTURE,
      absolute_expires_at: FUTURE,
      platform: "ios",
    });
    const res = await app.request("/api/v1/member/auth/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token?: string } };
    expect(body.data.token).toMatch(/^kmb_/);
    expect(body.data.token).not.toBe(TOKEN);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("REUSE: a replayed rotated token → neutral 401 (family already burned in the RPC)", async () => {
    const { app, fake } = refreshApp({ outcome: "reuse" });
    const res = await app.request("/api/v1/member/auth/refresh", { method: "POST", ...cookie });
    expect(res.status).toBe(401);
    // The RPC WAS called (it performed the family-revoke); the route just 401s.
    expect(fake.calls.some((call) => call.table === "refresh_member_session")).toBe(true);
    // No new cookie/token leaks on the failure path.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(["revoked", "expired", "not_found", "needs_resolution"])(
    "outcome '%s' → the SAME neutral 401",
    async (outcome) => {
      const { app } = refreshApp({ outcome });
      const res = await app.request("/api/v1/member/auth/refresh", { method: "POST", ...cookie });
      expect(res.status).toBe(401);
    },
  );

  it("401s (neutral) without a token — the RPC is never called", async () => {
    const { app, fake } = refreshApp({ outcome: "not_found" });
    const res = await app.request("/api/v1/member/auth/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    expect(fake.calls.some((call) => call.table === "refresh_member_session")).toBe(false);
  });
});

describe("GET /member/me", () => {
  it("returns the signed-in member's first name + session window, no balances", async () => {
    const { app } = sessionApp({ firstName: "Dana" });
    const res = await app.request("/api/v1/member/me", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { member: { first_name: string; claim_status: string }; session: { expires_at: string } };
    };
    expect(body.data.member.first_name).toBe("Dana");
    expect(body.data.member.claim_status).toBe("active");
    expect(body.data.session.expires_at).toBe(FUTURE);
    // No balances/bookings leak into the session view.
    expect(JSON.stringify(body.data)).not.toMatch(/balance|credit|booking/i);
  });

  it("401s (neutral) without a session token — never reaches the DB", async () => {
    const { app, fake } = sessionApp();
    const res = await app.request("/api/v1/member/me");
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("403s a needs_resolution session (resolveMember seals identity)", async () => {
    const { app } = sessionApp({ claimStatus: "needs_resolution" });
    const res = await app.request("/api/v1/member/me", cookie);
    expect(res.status).toBe(403);
  });
});

describe("POST /member/auth/logout", () => {
  it("revokes THIS session (scoped) + clears the host-only cookie", async () => {
    const { app, fake } = sessionApp();
    const res = await app.request("/api/v1/member/auth/logout", { method: "POST", ...cookie });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ revoked: true });

    // The revoke update is scoped to tenant + person + id (own session only).
    const update = fake.calls.find(
      (call) => call.table === "member_sessions" && call.method === "update",
    );
    expect(update).toBeDefined();
    const eqCalls = fake.calls.filter(
      (call) => call.table === "member_sessions" && call.method === "eq",
    );
    const eqCols = eqCalls.map((call) => call.args[0]);
    expect(eqCols).toEqual(expect.arrayContaining(["tenant_id", "person_id", "id"]));

    // An append-only session_revoked audit event is written.
    expect(
      fake.calls.some(
        (call) => call.table === "member_verification_events" && call.method === "insert",
      ),
    ).toBe(true);

    // The Set-Cookie clears the member cookie (Max-Age=0).
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${MEMBER_COOKIE}=`);
    expect(setCookie.toLowerCase()).toMatch(/max-age=0/);
  });

  it("401s (neutral) without a token", async () => {
    const { app } = sessionApp();
    const res = await app.request("/api/v1/member/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
