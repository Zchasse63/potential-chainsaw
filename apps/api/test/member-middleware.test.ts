import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import {
  MEMBER_COOKIE,
  MEMBER_SESSION_NEUTRAL_MESSAGE,
  resolveMember,
} from "../src/middleware/member.js";
import { memberOf, type AppEnv } from "../src/types.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";

/**
 * Unit 8.2b — resolveMember (plan-member-app §3.4), the sole source of member
 * person_id. Tested on a standalone Hono app (the session-scoped routes that
 * mount it for real are unit 8.2c; this unit ships the middleware + its
 * proofs). Neutral-failure contract: unknown / revoked / expired token is ONE
 * 401; an absent or non-active claim is a 403 with the SAME code + message.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = "kmb_testtoken0000000000000000000000000000000000a";
const PERSON_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_ID = "99999999-9999-4999-8999-999999999999";
const ATTACKER_PERSON = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ATTACKER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";

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
  activeClaimRows?: unknown[];
  latestClaimRows?: unknown[];
}

function memberApp(scenario: Scenario) {
  const fake = fakeUserClient({
    member_sessions: (calls: RecordedCall[]): FakeResult => {
      if (calls.some((call) => call.method === "update")) return { data: null };
      return { data: scenario.sessionRows ?? [sessionRow()] };
    },
    person_claims: (calls: RecordedCall[]): FakeResult => {
      if (calls.some((call) => call.method === "eq" && call.args[1] === "active")) {
        return { data: scenario.activeClaimRows ?? [{ status: "active" }] };
      }
      return { data: scenario.latestClaimRows ?? [{ status: "active" }] };
    },
  });

  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        { error: { code: err.code, message: err.message, correlation_id: "test" } },
        err.status,
      );
    }
    throw err;
  });
  app.use("/member/me", resolveMember({ createMemberClient: () => fake.client }));
  app.get("/member/me", (c) => c.json(memberOf(c)));
  return { app, fake };
}

function withCookie(): RequestInit {
  return { headers: { cookie: `${MEMBER_COOKIE}=${TOKEN}` } };
}

describe("resolveMember", () => {
  it("resolves a valid cookie session and slides the rolling expiry", async () => {
    const { app, fake } = memberApp({});
    const res = await app.request("/member/me", withCookie());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      memberTenantId: TENANT_A,
      memberPersonId: PERSON_ID,
      memberSessionId: SESSION_ID,
      memberStepUpAt: null,
    });

    // The lookup is by sha256(token) — the raw token never reaches a query.
    const lookup = fake.calls.find(
      (call) => call.table === "member_sessions" && call.method === "eq" && call.args[0] === "token_hash",
    );
    expect(lookup?.args[1]).toBe(sha256(TOKEN));

    // The slide: last_seen_at + expires_at rolled ~90 days out, scoped to the
    // session's OWN tenant + person.
    const update = fake.calls.find(
      (call) => call.table === "member_sessions" && call.method === "update",
    );
    const values = update?.args[0] as Record<string, unknown>;
    expect(typeof values["last_seen_at"]).toBe("string");
    const rolled = Date.parse(values["expires_at"] as string);
    expect(rolled).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);
    expect(rolled).toBeLessThan(Date.now() + 100 * 24 * 60 * 60 * 1000);

    // The cookie re-set slides the browser Max-Age with the DB expiry.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${MEMBER_COOKIE}=${TOKEN}`);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("accepts a mobile Bearer kmb_ token identically (no cookie re-set)", async () => {
    const { app } = memberApp({});
    const res = await app.request("/member/me", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memberPersonId).toBe(PERSON_ID);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a request-supplied person/tenant id is NEVER consulted", async () => {
    const { app, fake } = memberApp({});
    const res = await app.request(
      `/member/me?person_id=${ATTACKER_PERSON}&tenant=${ATTACKER_TENANT}`,
      withCookie(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memberPersonId).toBe(PERSON_ID);
    expect(body.memberTenantId).toBe(TENANT_A);
    // The attacker's ids reached NO query.
    expect(fake.calls.some((call) => call.args.includes(ATTACKER_PERSON))).toBe(false);
    expect(fake.calls.some((call) => call.args.includes(ATTACKER_TENANT))).toBe(false);
  });

  it("unknown, revoked, rolling-expired, and absolute-expired sessions are ONE neutral 401", async () => {
    const bodies: string[] = [];
    const scenarios: Scenario[] = [
      { sessionRows: [] }, // unknown token_hash
      { sessionRows: [sessionRow({ revoked_at: PAST })] },
      { sessionRows: [sessionRow({ expires_at: PAST })] },
      { sessionRows: [sessionRow({ absolute_expires_at: PAST })] },
    ];
    for (const scenario of scenarios) {
      const { app, fake } = memberApp(scenario);
      const res = await app.request("/member/me", withCookie());
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.message).toBe(MEMBER_SESSION_NEUTRAL_MESSAGE);
      bodies.push(JSON.stringify(body));
      // No slide happens for a rejected session.
      expect(fake.calls.some((call) => call.method === "update")).toBe(false);
    }
    // Byte-identical: nothing reveals WHICH check failed.
    expect(new Set(bodies).size).toBe(1);
  });

  it("a needs_resolution claim is a 403 with the SAME neutral shape as an unknown session", async () => {
    const { app, fake } = memberApp({
      activeClaimRows: [],
      latestClaimRows: [{ status: "needs_resolution" }],
    });
    const res = await app.request("/member/me", withCookie());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe(MEMBER_SESSION_NEUTRAL_MESSAGE);
    // No balances/identity leak, no slide.
    expect(fake.calls.some((call) => call.method === "update")).toBe(false);
  });

  it("an absent claim is the same neutral 403", async () => {
    const { app } = memberApp({ activeClaimRows: [], latestClaimRows: [] });
    const res = await app.request("/member/me", withCookie());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe(MEMBER_SESSION_NEUTRAL_MESSAGE);
  });

  it("no credential at all → the neutral 401", async () => {
    const { app, fake } = memberApp({});
    const res = await app.request("/member/me");
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0); // no DB work without a token
  });

  it("a non-kmb_ credential is refused before any lookup", async () => {
    const { app, fake } = memberApp({});
    const res = await app.request("/member/me", {
      headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.staff.jwt" },
    });
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
});
