import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { TENANT_A, USER_ID, fakeUserClient } from "./fakes.js";

const CAMPAIGN_ID = "24000000-0000-4000-8000-000000000101";
const SEND_ID = "24000000-0000-4000-8000-000000000201";
const PERSON_ID = "24000000-0000-4000-8000-000000000301";

const campaign = {
  id: CAMPAIGN_ID,
  name: "At risk · July 18",
  segment_key: "at_risk",
  template_key: "at_risk_winback_email",
  channel: "email",
  kind: "marketing",
  draft_subject: "A note from {{studio_name}}",
  draft_body: "Hi {{first_name}} from {{studio_name}}",
  draft_source: "ai",
  status: "pending_approval",
  created_by: USER_ID,
  approved_by: null,
  approved_at: null,
  scheduled_for: null,
  created_at: "2026-07-18T12:00:00.000Z",
  updated_at: "2026-07-18T12:00:00.000Z",
};

function ownerFake(role: "owner" | "front_desk") {
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
      campaigns: () => ({ data: [campaign] }),
      campaign_sends: () => ({
        data: [
          {
            id: SEND_ID,
            person_id: PERSON_ID,
            channel: "email",
            planned_status: "eligible",
            comms_log_id: null,
            created_at: "2026-07-18T12:01:00.000Z",
            person: { first_name: "Maria", last_name: "R", email: "m@example.com", phone: null },
          },
        ],
      }),
      tenants: () => ({ data: [{ id: TENANT_A, name: "Kelo" }] }),
      campaign_attributions: () => ({ data: [] }),
    },
    { approve_campaign: () => ({ data: 1 }) },
  );
}

describe("marketing approval API", () => {
  it("requires owner/manager before the sole send-trigger RPC", async () => {
    const fake = ownerFake("front_desk");
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });
    const response = await app.request(`/api/v1/marketing/campaigns/${CAMPAIGN_ID}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer token", "idempotency-key": "approval-1" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(fake.calls.some((call) => call.table === "approve_campaign")).toBe(false);
  });

  it("passes the authenticated actor to the idempotent approval RPC and returns its count", async () => {
    const fake = ownerFake("owner");
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });
    const response = await app.request(`/api/v1/marketing/campaigns/${CAMPAIGN_ID}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer token", "idempotency-key": "approval-2" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { enqueued: 1 } });
    const rpc = fake.calls.find((call) => call.table === "approve_campaign");
    expect(rpc?.args[0]).toEqual({ p_campaign: CAMPAIGN_ID, p_actor: USER_ID });
  });

  it("requires an idempotency key on approval", async () => {
    const fake = ownerFake("owner");
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });
    const response = await app.request(`/api/v1/marketing/campaigns/${CAMPAIGN_ID}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: "{}",
    });
    expect(response.status).toBe(422);
    expect(fake.calls.some((call) => call.table === "approve_campaign")).toBe(false);
  });
});
