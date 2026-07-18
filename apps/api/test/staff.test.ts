import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashStepUpPin, validateStepUpGrant } from "../src/auth/stepup.js";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID, type RecordedCall, type RpcHandler } from "./fakes.js";

const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const ROW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "test-step-up-secret-is-at-least-32-bytes-long";
const NOW = "2026-07-18T12:00:00.000Z";

function membership(role: string) {
  return { tenant_id: TENANT_A, role };
}

function tenantUser(userId: string, role: string, status = "active") {
  return {
    id: ROW_ID,
    user_id: userId,
    role,
    status,
    invited_by: null,
    created_at: NOW,
  };
}

function appFor(
  role: string,
  tenantUsers: (calls: RecordedCall[]) => { data: unknown },
  rpcHandlers: Record<string, RpcHandler> = {},
  extraTables: Record<string, (calls: RecordedCall[]) => { data: unknown }> = {},
) {
  const fake = fakeUserClient({ tenant_users: tenantUsers, ...extraTables }, rpcHandlers);
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
    createStepUpClient: () => fake.client,
    env: { STEP_UP_SECRET: SECRET },
  });
  return { app, fake, role };
}

function post(body: unknown) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer good-token",
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  } as const;
}

describe("GET /api/v1/staff", () => {
  it("returns a manager roster without ever exposing step_up_pin_hash", async () => {
    const { app } = appFor(
      "manager",
      (calls) => {
        const columns = calls.find((call) => call.method === "select")?.args[0];
        if (columns === "tenant_id, role") return { data: [membership("manager")] };
        return {
          data: [
            {
              id: ROW_ID,
              user_id: OTHER_USER,
              role: "front_desk",
              status: "active",
              step_up_pin_set_at: NOW,
              step_up_locked_until: null,
              step_up_fail_count: 0,
              step_up_pin_hash: "must-never-cross-the-boundary",
              created_at: NOW,
            },
          ],
        };
      },
      {},
      {
        step_up_events: () => ({
          data: [{ tenant_user_id: ROW_ID, kind: "verify_success", created_at: NOW }],
        }),
      },
    );
    const response = await app.request("/api/v1/staff", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("step_up_pin_hash");
    expect(text).not.toContain("must-never-cross-the-boundary");
    expect(JSON.parse(text).data.staff[0]).toMatchObject({
      user_id: OTHER_USER,
      role: "front_desk",
      pin_set: true,
      can_manage_pin: true,
    });
  });

  for (const role of ["front_desk", "trainer"]) {
    it(`403s roster access for ${role}`, async () => {
      const { app, fake } = appFor(role, () => ({ data: [membership(role)] }));
      const response = await app.request("/api/v1/staff", {
        headers: { authorization: "Bearer good-token" },
      });
      expect(response.status).toBe(403);
      expect(fake.calls.some((call) => call.table === "step_up_events")).toBe(false);
    });
  }
});

describe("POST /api/v1/staff/:userId/pin", () => {
  function setPinApp(actorRole: string, targetId: string, targetRole: string) {
    let rpcParams: Record<string, unknown> | undefined;
    const result = appFor(
      actorRole,
      (calls) => {
        const columns = calls.find((call) => call.method === "select")?.args[0];
        if (columns === "tenant_id, role") return { data: [membership(actorRole)] };
        return { data: [tenantUser(targetId, targetRole)] };
      },
      {
        set_step_up_pin: (params) => {
          rpcParams = params;
          return { data: null };
        },
      },
    );
    return { ...result, rpcParams: () => rpcParams };
  }

  it("allows self-service and sends only a scrypt hash to the DB", async () => {
    const { app, rpcParams } = setPinApp("front_desk", USER_ID, "front_desk");
    const response = await app.request(`/api/v1/staff/${USER_ID}/pin`, post({ pin: "1234" }));
    expect(response.status).toBe(200);
    expect(rpcParams()?.p_actor).toBe(USER_ID);
    expect(rpcParams()?.p_user).toBe(USER_ID);
    expect(rpcParams()?.p_pin_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(JSON.stringify(rpcParams())).not.toContain("1234");
  });

  it("allows owner → front_desk but rejects front_desk → owner", async () => {
    const allowed = setPinApp("owner", OTHER_USER, "front_desk");
    expect(
      (await allowed.app.request(`/api/v1/staff/${OTHER_USER}/pin`, post({ pin: "5678" }))).status,
    ).toBe(200);

    const denied = setPinApp("front_desk", OTHER_USER, "owner");
    const deniedResponse = await denied.app.request(
      `/api/v1/staff/${OTHER_USER}/pin`,
      post({ pin: "5678" }),
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.rpcParams()).toBeUndefined();
  });

  it("422s non-decimal or out-of-range PINs before hashing", async () => {
    const { app, rpcParams } = setPinApp("owner", USER_ID, "owner");
    const response = await app.request(`/api/v1/staff/${USER_ID}/pin`, post({ pin: "1234567" }));
    expect(response.status).toBe(422);
    expect(rpcParams()).toBeUndefined();
  });

  it("has no email-reset endpoint and the SQL setter binds actor to auth.uid", async () => {
    const { app } = setPinApp("owner", USER_ID, "owner");
    const absent = await app.request(
      "/api/v1/auth/reset-step-up-pin",
      post({ email: "owner@example.com" }),
    );
    expect(absent.status).toBe(404);

    const sql = readFileSync("supabase/migrations/20260718220100_0026_step_up_auth.sql", "utf8");
    expect(sql).toContain("(select auth.uid()) <> p_actor");
    expect(sql.match(/set step_up_pin_hash =/g)).toHaveLength(1);
    expect(sql).toContain("v_actor_rank <= v_target_rank");
    expect(sql).toContain("'aal2'");
    expect(sql).toContain("<> 'service_role'");
    expect(sql).toContain("revoke update on public.tenant_users");
  });
});

describe("POST /api/v1/staff/step-up/verify", () => {
  it("locks on the fifth failure and performs no further credential comparison", async () => {
    const credential = hashStepUpPin("1234");
    let failures = 0;
    let lockedUntil: string | null = null;
    let credentialReads = 0;
    const { app } = appFor(
      "front_desk",
      (calls) => {
        const columns = calls.find((call) => call.method === "select")?.args[0];
        if (columns === "tenant_id, role") return { data: [membership("front_desk")] };
        if (columns === "step_up_pin_hash") {
          credentialReads += 1;
          return { data: [{ step_up_pin_hash: credential }] };
        }
        return { data: [] };
      },
      {
        step_up_status: () => ({
          data: [{ pin_set: true, locked_until: lockedUntil, fail_count: failures }],
        }),
        record_step_up_attempt: () => {
          failures += 1;
          if (failures >= 5) lockedUntil = "2026-07-18T12:15:00.000Z";
          return {
            data: [
              {
                locked_until: lockedUntil,
                fail_count: failures,
                remaining_attempts: Math.max(0, 5 - failures),
                attempt_recorded: true,
              },
            ],
          };
        },
      },
    );

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await app.request(
        "/api/v1/staff/step-up/verify",
        post({ pin: "9999", context: "manual_grant" }),
      );
      expect(response.status).toBe(401);
    }
    const fifth = await app.request(
      "/api/v1/staff/step-up/verify",
      post({ pin: "9999", context: "manual_grant" }),
    );
    expect(fifth.status).toBe(423);
    expect(credentialReads).toBe(5);

    const whileLocked = await app.request(
      "/api/v1/staff/step-up/verify",
      post({ pin: "1234", context: "manual_grant" }),
    );
    expect(whileLocked.status).toBe(423);
    expect(credentialReads).toBe(5);
  });

  it("returns a signed, context-scoped, short-lived grant after success", async () => {
    const credential = hashStepUpPin("2468");
    const { app } = appFor(
      "manager",
      (calls) => {
        const columns = calls.find((call) => call.method === "select")?.args[0];
        if (columns === "tenant_id, role") return { data: [membership("manager")] };
        return { data: [{ step_up_pin_hash: credential }] };
      },
      {
        step_up_status: () => ({
          data: [{ pin_set: true, locked_until: null, fail_count: 0 }],
        }),
        record_step_up_attempt: () => ({
          data: [
            {
              locked_until: null,
              fail_count: 0,
              remaining_attempts: 5,
              attempt_recorded: true,
            },
          ],
        }),
      },
    );
    const response = await app.request(
      "/api/v1/staff/step-up/verify",
      post({
        pin: "2468",
        context: "refund_over_threshold",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { grant_token: string; grant: { context: string } };
    };
    expect(body.data.grant.context).toBe("refund_over_threshold");
    expect(validateStepUpGrant(body.data.grant_token, SECRET)).toMatchObject({
      sub: USER_ID,
      tenant: TENANT_A,
      context: "refund_over_threshold",
    });
    expect(validateStepUpGrant(`${body.data.grant_token}x`, SECRET)).toBeNull();
  });
});
