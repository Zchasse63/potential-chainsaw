import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, TENANT_B, USER_ID } from "./fakes.js";

// Threat model §1: tenant id is ALWAYS derived server-side from membership —
// a tenant_id in the request body is ignored, never trusted.
describe("resolveTenant: tenant comes from membership, never the request", () => {
  it("ignores tenant_id in the request body and resolves the membership tenant", async () => {
    const fake = fakeUserClient({
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: "owner" }] }),
      tenants: () => ({
        data: [
          {
            id: TENANT_A,
            name: "Studio A",
            slug: "studio-a",
            settings: { briefing_hour: 6 },
            status: "active",
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
      audit_events: () => ({ data: null }),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    const res = await app.request("/api/v1/tenant", {
      method: "PATCH",
      headers: {
        authorization: "Bearer good-token",
        "content-type": "application/json",
        "idempotency-key": "key-1",
      },
      // The attacker-controlled tenant id: must be dropped unread.
      body: JSON.stringify({ tenant_id: TENANT_B, settings: { briefing_hour: 6 } }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { tenant: { id: string } } };
    expect(body.data.tenant.id).toBe(TENANT_A);

    // The update targeted the MEMBERSHIP tenant…
    const tenantEq = fake.calls.find(
      (call) => call.table === "tenants" && call.method === "eq" && call.args[0] === "id",
    );
    expect(tenantEq?.args[1]).toBe(TENANT_A);

    // …and the body's tenant_id never reached any query.
    const usedBodyTenant = fake.calls.some((call) => call.args.includes(TENANT_B));
    expect(usedBodyTenant).toBe(false);
  });

  it("403s a user with no active membership", async () => {
    const fake = fakeUserClient({
      tenant_users: () => ({ data: [] }),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    const res = await app.request("/api/v1/tenant", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_active_membership");
  });

  it("multi-tenant users must name a membership tenant via x-kelo-tenant", async () => {
    const memberships = [
      { tenant_id: TENANT_A, role: "owner" },
      { tenant_id: TENANT_B, role: "front_desk" },
    ];
    const fake = fakeUserClient({
      tenant_users: () => ({ data: memberships }),
      tenants: () => ({
        data: [
          {
            id: TENANT_B,
            name: "Studio B",
            slug: "studio-b",
            settings: {},
            status: "active",
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    // Missing header → 400.
    const missing = await app.request("/api/v1/tenant", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(missing.status).toBe(400);

    // A tenant the user does NOT belong to → 400 (never resolved).
    const foreign = await app.request("/api/v1/tenant", {
      headers: {
        authorization: "Bearer good-token",
        "x-kelo-tenant": "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    });
    expect(foreign.status).toBe(400);

    // A valid membership tenant → resolved, with that membership's role.
    const okRes = await app.request("/api/v1/tenant", {
      headers: { authorization: "Bearer good-token", "x-kelo-tenant": TENANT_B },
    });
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as { data: { tenant: { id: string } } };
    expect(body.data.tenant.id).toBe(TENANT_B);
  });
});
