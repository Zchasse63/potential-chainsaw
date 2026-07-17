import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID, type RecordedCall } from "./fakes.js";

/**
 * PATCH /tenant/users/:id mirrors the hardened RLS policy (migration 0004):
 * membership writes are OWNER-only and never self-directed. The API rejects
 * loudly (403) what RLS would silently filter to 0 rows. These are the
 * API-layer siblings of attack-suite probes (15)-(17).
 */

const ROW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

function memberRow(userId: string, role: string) {
  return {
    id: ROW_ID,
    user_id: userId,
    role,
    status: "active",
    invited_by: null,
    created_at: "2026-07-01T00:00:00Z",
  };
}

/** tenant_users answers: membership fetch vs member fetch vs update. */
function tenantUsersHandler(targetUserId: string, sessionRole: string) {
  return (tableCalls: RecordedCall[]) => {
    if (tableCalls.some((call) => call.method === "update")) {
      return { data: [memberRow(targetUserId, "trainer")] };
    }
    if (tableCalls.some((call) => call.method === "eq" && call.args[0] === "id")) {
      return { data: [memberRow(targetUserId, "manager")] };
    }
    return { data: [{ tenant_id: TENANT_A, role: sessionRole }] };
  };
}

function request(app: ReturnType<typeof createApp>) {
  return app.request(`/api/v1/tenant/users/${ROW_ID}`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer good-token",
      "content-type": "application/json",
      "idempotency-key": "key-1",
    },
    body: JSON.stringify({ role: "trainer" }),
  });
}

describe("PATCH /tenant/users/:id — owner-only, never self (RLS mirror)", () => {
  it("403s a manager (insufficient_role) — no self-escalation via the API", async () => {
    const fake = fakeUserClient({
      tenant_users: tenantUsersHandler(USER_ID, "manager"),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    const res = await request(app);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("insufficient_role");
    // The guard fired before any tenant_users write.
    expect(fake.calls.some((c) => c.table === "tenant_users" && c.method === "update")).toBe(false);
  });

  it("403s an owner targeting their OWN membership row", async () => {
    const fake = fakeUserClient({
      tenant_users: tenantUsersHandler(USER_ID, "owner"),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    const res = await request(app);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("cannot_modify_own_membership");
    expect(fake.calls.some((c) => c.table === "tenant_users" && c.method === "update")).toBe(false);
  });

  it("200s an owner updating ANOTHER member, and audits it (positive control)", async () => {
    const fake = fakeUserClient({
      tenant_users: tenantUsersHandler(OTHER_USER, "owner"),
      audit_events: () => ({ data: null }),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    const res = await request(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { member: { role: string } } };
    expect(body.data.member.role).toBe("trainer");
    // The update ran and the audit event was written.
    expect(fake.calls.some((c) => c.table === "tenant_users" && c.method === "update")).toBe(true);
    expect(fake.calls.some((c) => c.table === "audit_events" && c.method === "insert")).toBe(true);
  });
});
