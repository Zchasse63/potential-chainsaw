import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID, type RecordedCall } from "./fakes.js";

const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const FEEDBACK_ID = "33333333-3333-4333-8333-333333333333";
const DISMISSAL_ID = "44444444-4444-4444-8444-444444444444";
const PERSON_A = "55555555-5555-4555-8555-555555555555";
const PERSON_B = "66666666-6666-4666-8666-666666666666";
const headers = {
  authorization: "Bearer good-token",
  "idempotency-key": "unit-test-action",
};

function inserted(calls: RecordedCall[]): Record<string, unknown> {
  const call = calls.find((entry) => entry.method === "insert");
  if (call === undefined) throw new Error("expected insert call");
  return call.args[0] as Record<string, unknown>;
}

function api(
  handlers: Parameters<typeof fakeUserClient>[0],
  rpcHandlers: Parameters<typeof fakeUserClient>[1] = {},
) {
  const fake = fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: "owner" }] }),
      locations: () => ({ data: [{ timezone: "UTC" }] }),
      ...handlers,
    },
    rpcHandlers,
  );
  return {
    fake,
    app: createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    }),
  };
}

function artifact(generatedFor: string) {
  return {
    id: ARTIFACT_ID,
    generated_for: generatedFor,
    status: "generated",
    prompt_version: 1,
    model: "test-model",
    input: { candidates: [] },
    input_hash: "abc123",
    output: { insights: [] },
    cost_usd: 0.01,
    error: null,
    created_at: "2026-07-18T10:00:00Z",
  };
}

describe("GET /api/v1/briefing", () => {
  it("returns a structured 404 when today's artifact does not exist", async () => {
    const { app } = api({ ai_artifacts: () => ({ data: [] }) });
    const response = await app.request("/api/v1/briefing", { headers });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "briefing_not_generated" },
    });
  });

  it("serves yesterday only when requested and badges it stale", async () => {
    let artifactReads = 0;
    const { app } = api({
      ai_artifacts: (calls) => {
        artifactReads += 1;
        if (artifactReads === 1) return { data: [] };
        const dateCall = calls.find(
          (call) => call.method === "eq" && call.args[0] === "generated_for",
        );
        return { data: [artifact(String(dateCall?.args[1]))] };
      },
    });
    const response = await app.request("/api/v1/briefing?fallback=yesterday", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { artifact: { generated_for: string } };
      meta: { stale: boolean; definition_version: string };
    };
    expect(artifactReads).toBe(2);
    expect(body.meta).toMatchObject({ stale: true, definition_version: "1" });
    expect(body.data.artifact.generated_for).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("briefing and focus mutations", () => {
  it("stamps feedback with the verified actor and resolved tenant", async () => {
    const { app, fake } = api({
      briefing_feedback: (calls) => {
        const row = inserted(calls);
        return {
          data: [
            {
              id: FEEDBACK_ID,
              artifact_id: row["artifact_id"],
              item_ref: row["item_ref"],
              verdict: row["verdict"],
              reason: row["reason"],
              actor_user_id: row["actor_user_id"],
              created_at: "2026-07-18T11:00:00Z",
            },
          ],
        };
      },
    });
    const response = await app.request("/api/v1/briefing/feedback", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        artifact_id: ARTIFACT_ID,
        item_ref: "hooked:conversion_opportunity",
        verdict: "up",
      }),
    });
    expect(response.status).toBe(201);
    const insertCall = fake.calls.find(
      (call) => call.table === "briefing_feedback" && call.method === "insert",
    );
    expect(insertCall?.args[0]).toMatchObject({
      tenant_id: TENANT_A,
      actor_user_id: USER_ID,
    });
  });

  it("stamps dismissals with the verified actor", async () => {
    const { app, fake } = api({
      focus_dismissals: (calls) => {
        const row = inserted(calls);
        return {
          data: [
            {
              id: DISMISSAL_ID,
              item_key: row["item_key"],
              action: row["action"],
              reason: row["reason"],
              snooze_until: row["snooze_until"],
              actor_user_id: row["actor_user_id"],
              created_at: "2026-07-18T11:00:00Z",
            },
          ],
        };
      },
    });
    const response = await app.request("/api/v1/focus-queue/dismiss", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ item_key: `at_risk:${PERSON_A}`, action: "dismissed" }),
    });
    expect(response.status).toBe(201);
    const insertCall = fake.calls.find(
      (call) => call.table === "focus_dismissals" && call.method === "insert",
    );
    expect(insertCall?.args[0]).toMatchObject({
      tenant_id: TENANT_A,
      actor_user_id: USER_ID,
    });
  });
});

describe("GET /api/v1/focus-queue", () => {
  it("joins member-scoped names and excludes an actively snoozed item", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { app } = api(
      {
        focus_dismissals: () => ({
          data: [
            {
              item_key: `at_risk:${PERSON_A}`,
              action: "snoozed",
              snooze_until: future,
              created_at: new Date().toISOString(),
            },
          ],
        }),
        people: () => ({
          data: [
            { id: PERSON_A, first_name: "Ari", last_name: "A" },
            { id: PERSON_B, first_name: "Bea", last_name: "B" },
          ],
        }),
      },
      {
        segment_current: () => ({
          data: [
            {
              segment_key: "at_risk",
              person_id: PERSON_A,
              priority: 2,
              rule_version: 1,
              evidence: { days_since_attendance: 25 },
            },
            {
              segment_key: "hooked",
              person_id: PERSON_B,
              priority: 4,
              rule_version: 1,
              evidence: { attended_count: 3 },
            },
          ],
        }),
        kpi_failed_payments: () => ({
          data: [{ failed_count: 0, failed_sum: 0, people: 0 }],
        }),
      },
    );
    const response = await app.request("/api/v1/focus-queue", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { items: Array<{ item_key: string; facts: Record<string, unknown> }> };
    };
    expect(body.data.items).toEqual([
      expect.objectContaining({
        item_key: `hooked:${PERSON_B}`,
        facts: expect.objectContaining({ first_name: "Bea", last_name: "B" }),
      }),
    ]);
  });
});
