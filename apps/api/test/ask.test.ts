import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { stripNameFields } from "../src/ask/narrate.js";
import { TENANT_A, USER_ID, fakeUserClient, type RecordedCall } from "./fakes.js";

const CATALOG_ID = "22222222-2222-4222-8222-222222222222";
const MISS_ID = "33333333-3333-4333-8333-333333333333";
const headers = {
  authorization: "Bearer good-token",
  "content-type": "application/json",
  "idempotency-key": "ask-test",
};

function catalogEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: CATALOG_ID,
    key: "member_count_current",
    version: 1,
    title: "Current member count",
    description: "The current recurring-member cohort count.",
    params_schema: {},
    metric_keys: ["member_count"],
    created_at: "2026-07-18T17:01:00.000Z",
    ...overrides,
  };
}

function anthropicJson(output: unknown): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(output) }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function askApp(options: {
  catalog?: ReturnType<typeof catalogEntry>[];
  fetchImpl?: typeof fetch;
  apiKey?: string;
  rpc?: Parameters<typeof fakeUserClient>[1];
}) {
  const fake = fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: "owner" }] }),
      locations: () => ({ data: [{ timezone: "UTC" }] }),
      ask_catalog: () => ({ data: options.catalog ?? [catalogEntry()] }),
      ask_misses: (calls) => {
        const insert = calls.find((call) => call.method === "insert");
        return {
          data: insert === undefined ? [] : [{ id: MISS_ID, created_at: "2026-07-18T18:00:00.000Z" }],
        };
      },
      metric_definitions: () => ({
        data: [{ key: "member_count", version: 1, definition: "The recurring member cohort." }],
      }),
    },
    options.rpc ?? { kpi_member_count: () => ({ data: 22 }) },
  );
  return {
    fake,
    app: createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
      anthropicFetch: options.fetchImpl,
      env: { ANTHROPIC_API_KEY: options.apiKey ?? "test-key" },
    }),
  };
}

function inserted(calls: RecordedCall[]): Record<string, unknown> {
  const call = calls.find((entry) => entry.table === "ask_misses" && entry.method === "insert");
  if (call === undefined) throw new Error("expected ask_misses insert");
  return call.args[0] as Record<string, unknown>;
}

describe("POST /api/v1/ask", () => {
  it("logs a selector miss with the verified actor and returns the honest catalog copy", async () => {
    const fetchImpl = vi.fn(async () => anthropicJson({ miss: true })) as unknown as typeof fetch;
    const { app, fake } = askApp({ fetchImpl });
    const response = await app.request("/api/v1/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "Which instructor makes the most money?" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        miss: true,
        answer: { narration: "I can't answer that yet — here's what I can answer from the approved catalog." },
        catalog: [{ key: "member_count_current" }],
      },
    });
    expect(inserted(fake.calls)).toMatchObject({
      tenant_id: TENANT_A,
      asked_by: USER_ID,
      question: "Which instructor makes the most money?",
    });
    expect(fake.calls.some((call) => call.method === "rpc")).toBe(false);
  });

  it("422s model-selected bad parameters before executing any catalog function", async () => {
    const selected = catalogEntry({
      key: "top_customers_by_revenue",
      title: "Top customers by collected revenue",
      params_schema: {
        from: { type: "date", required: true },
        to: { type: "date", required: true },
        limit: { type: "int", required: true },
      },
      metric_keys: ["collected_revenue"],
    });
    const fetchImpl = vi.fn(async () =>
      anthropicJson({
        key: "top_customers_by_revenue",
        params: { from: "2026-07-01", to: "2026-07-18", limit: "ten" },
      }),
    ) as unknown as typeof fetch;
    const { app, fake } = askApp({ catalog: [selected], fetchImpl });
    const response = await app.request("/api/v1/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "Who are the top customers?" }),
    });
    expect(response.status).toBe(422);
    expect(fake.calls.some((call) => call.method === "rpc")).toBe(false);
  });

  it("drops narration that invents a number after one retry but still returns authoritative rows", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(anthropicJson({ key: "member_count_current", params: {} }))
      .mockResolvedValueOnce(anthropicJson({ narration: "There are 999 current members." }))
      .mockResolvedValueOnce(anthropicJson({ narration: "Still 999 current members." })) as unknown as typeof fetch;
    const { app } = askApp({ fetchImpl });
    const response = await app.request("/api/v1/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "What is the current member count?" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { answer: { narration: string | null; rows: unknown[]; note: string } } };
    expect(body.data.answer.narration).toBeNull();
    expect(body.data.answer.rows).toEqual([{ member_count: 22 }]);
    expect(body.data.answer.note).toContain("rows are the answer");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses a conservative catalog-title match and rows-only mode when no Anthropic key exists", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { app } = askApp({ fetchImpl, apiKey: "" });
    const response = await app.request("/api/v1/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "Current member count" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        miss: false,
        answer: { narration: null, rows: [{ member_count: 22 }] },
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/ask/catalog", () => {
  it("returns the global read-only registry in an envelope", async () => {
    const { app } = askApp({ apiKey: "" });
    const response = await app.request("/api/v1/ask/catalog", { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { catalog: [{ key: "member_count_current", version: 1 }] },
      meta: { source: "native", definition_version: "1" },
    });
  });
});

describe("ask provider privacy projection", () => {
  it("removes name-like response fields before narration while retaining approved ids and facts", () => {
    expect(
      stripNameFields([
        {
          person_id: "44444444-4444-4444-8444-444444444444",
          first_name: "Ari",
          last_name: "Lane",
          collected: 125,
        },
      ]),
    ).toEqual([
      { person_id: "44444444-4444-4444-8444-444444444444", collected: 125 },
    ]);
  });
});
