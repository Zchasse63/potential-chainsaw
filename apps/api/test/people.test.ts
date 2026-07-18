import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, TENANT_B, USER_ID } from "./fakes.js";

const PERSON_ID = "25000000-0000-4000-8000-000000000101";
const EXPORT_ID = "25000000-0000-4000-8000-000000000102";
const DELETION_ID = "25000000-0000-4000-8000-000000000103";
const OTHER_ACTOR = "25000000-0000-4000-8000-000000000104";

const deletion = {
  id: DELETION_ID,
  tenant_id: TENANT_A,
  person_id: PERSON_ID,
  requested_by: USER_ID,
  reason: "subject request",
  mode: "pseudonymize",
  scrubbed_fields: ["people.email", "comms_log.body_preview"],
  preserved_note: "financial evidence retained",
  executed_at: "2026-07-18T20:00:00.000Z",
  created_at: "2026-07-18T20:00:00.000Z",
};

function build(role: "owner" | "manager" | "front_desk" | "trainer" = "owner") {
  const fake = fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
      data_exports: () => ({
        data: [{
          id: EXPORT_ID,
          subject_person_id: PERSON_ID,
          requested_by: USER_ID,
          status: "ready",
          artifact: { export_type: "person_dsar", people: { id: PERSON_ID } },
          row_counts: { people: 1 },
          error: null,
          expires_at: "2099-07-25T20:00:00.000Z",
          created_at: "2026-07-18T20:00:00.000Z",
          updated_at: "2026-07-18T20:01:00.000Z",
        }],
      }),
      retention_policies: () => ({
        data: [{
          id: "25000000-0000-4000-8000-000000000001",
          tenant_id: null,
          data_class: "comms_content",
          retention_days: 730,
          action: "scrub_body",
          legal_basis: "minimization",
          preserves: "send metadata",
          version: 1,
          created_at: "2026-07-18T00:00:00.000Z",
        }],
      }),
    },
    {
      request_person_export: () => ({ data: EXPORT_ID }),
      pseudonymize_person: () => ({ data: deletion }),
    },
  );
  return {
    fake,
    app: createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    }),
  };
}

const auth = { authorization: "Bearer token" };

describe("people data-rights API", () => {
  it("queues a subject-only export with resolved tenant/actor and returns 202", async () => {
    const { app, fake } = build();
    const response = await app.request(`/api/v1/people/${PERSON_ID}/export`, {
      headers: { ...auth, "idempotency-key": "export-once" },
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: { export_id: EXPORT_ID, status: "queued" },
    });
    const rpc = fake.calls.find((call) => call.table === "request_person_export");
    expect(rpc?.args[0]).toEqual({
      p_tenant: TENANT_A,
      p_person: PERSON_ID,
      p_actor: USER_ID,
      p_idempotency_key: "export-once",
    });
  });

  it("returns ready export status plus the assembled bundle", async () => {
    const { app } = build();
    const response = await app.request(`/api/v1/data-exports/${EXPORT_ID}`, { headers: auth });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { export: { status: "ready", artifact: { export_type: "person_dsar" } } },
    });
  });

  it("pseudonymizes through the user RPC using only resolved tenant and actor", async () => {
    const { app, fake } = build();
    const response = await app.request(`/api/v1/people/${PERSON_ID}/delete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "idempotency-key": "erase-once" },
      body: JSON.stringify({
        reason: "subject request",
        tenantId: TENANT_B,
        actorId: OTHER_ACTOR,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { deletion } });
    const rpc = fake.calls.find((call) => call.table === "pseudonymize_person");
    expect(rpc?.args[0]).toEqual({
      p_tenant: TENANT_A,
      p_person: PERSON_ID,
      p_actor: USER_ID,
      p_reason: "subject request",
    });
  });

  it.each(["front_desk", "trainer"] as const)(
    "403s %s before delete and export RPCs",
    async (role) => {
      const { app, fake } = build(role);
      const deletionResponse = await app.request(`/api/v1/people/${PERSON_ID}/delete`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "erase" },
        body: "{}",
      });
      const exportResponse = await app.request(`/api/v1/people/${PERSON_ID}/export`, {
        headers: { ...auth, "idempotency-key": "export" },
      });
      expect(deletionResponse.status).toBe(403);
      expect(exportResponse.status).toBe(403);
      expect(fake.calls.some((call) => call.table === "pseudonymize_person")).toBe(false);
      expect(fake.calls.some((call) => call.table === "request_person_export")).toBe(false);
    },
  );

  it("returns the effective matrix in a definition-versioned envelope", async () => {
    const { app } = build();
    const response = await app.request("/api/v1/retention/policies", { headers: auth });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { policies: [{ data_class: "comms_content", retention_days: 730 }] },
      meta: { definition_version: "retention-matrix:v1" },
    });
  });
});
