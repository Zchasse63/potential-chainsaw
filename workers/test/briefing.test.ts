import { describe, expect, it, vi } from "vitest";
import { buildCandidates } from "../src/briefing/candidates.js";
import { runBriefing } from "../src/briefing/generate.js";
import { selectCandidates } from "../src/briefing/select.js";
import { synthesizeBriefing } from "../src/briefing/synthesize.js";
import type { Candidate } from "../src/briefing/types.js";
import { processors, type Queryable } from "../src/processors.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECONCILIATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function candidate(
  id: string,
  category: Candidate["category"],
  impact: number,
  facts: Record<string, number> = { people: 3 },
): Candidate {
  return {
    id,
    category,
    headline_facts: facts,
    impact_score: impact,
    evidence: { metric_refs: [], segment_keys: [], person_ids: [] },
  };
}

function fakePool(rows: unknown[]): { pool: Queryable; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    pool: {
      query: async (text) => {
        sql.push(text);
        return { rows };
      },
    },
  };
}

describe("briefing candidate generation", () => {
  it("registers derive.briefing without dropping the shared processor kinds", () => {
    expect(processors["derive.briefing"]).toBeTypeOf("function");
    expect(processors["noop"]).toBeTypeOf("function");
    expect(processors["heartbeat"]).toBeTypeOf("function");
  });

  it("accepts deterministic SQL candidates for a >20% revenue delta and at-risk growth", async () => {
    const rows = [
      candidate("revenue:7d_delta", "revenue", 250, {
        current_net: 1250,
        prior_net: 1000,
        delta_net: 250,
        delta_percent: 25,
        window_days: 7,
        threshold_percent: 20,
      }),
      candidate("at_risk:growth", "retention", 300, {
        current_count: 8,
        prior_count: 5,
        growth_count: 3,
        threshold_growth: 3,
      }),
    ];
    const fake = fakePool(rows);
    await expect(buildCandidates(fake.pool, TENANT)).resolves.toEqual(rows);
    expect(fake.sql).toHaveLength(1);
    expect(fake.sql[0]).toContain("abs(r.delta_percent) > 20");
    expect(fake.sql[0]).toContain("sp.current_count - sp.prior_count >= 3");
    expect(fake.sql[0]).toContain("order by impact_score desc, id");
  });

  it("returns no revenue candidate when SQL reports a below-threshold day", async () => {
    const fake = fakePool([]);
    await expect(buildCandidates(fake.pool, TENANT)).resolves.toEqual([]);
    expect(fake.sql[0]).toContain("threshold_percent', 20");
  });
});

describe("candidate selection", () => {
  it("enforces category diversity and always includes data health", () => {
    const selected = selectCandidates([
      candidate("revenue:a", "revenue", 1000),
      candidate("revenue:b", "revenue", 900),
      candidate("revenue:c", "revenue", 800),
      candidate("payments:a", "payments", 700),
      candidate("data_health:a", "data_health", 2),
    ]);
    expect(selected.map((item) => item.id)).toEqual([
      "revenue:a",
      "payments:a",
      "data_health:a",
    ]);
  });

  it("returns the honest empty state when nothing clears the floor", () => {
    expect(selectCandidates([candidate("tiny", "revenue", 0.5)])).toEqual([]);
  });
});

function anthropicResponse(output: unknown, inputTokens = 100, outputTokens = 20): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(output) }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Claude synthesis", () => {
  it("accepts schema-valid prose whose numbers all occur in its candidate facts", async () => {
    const selectedCandidate = candidate("hooked:conversion_opportunity", "conversion", 225);
    selectedCandidate.evidence["first_name"] = "private-name-must-not-leave";
    selectedCandidate.evidence["email"] = "private@example.test";
    const selected = [selectedCandidate];
    const fetchImpl = vi.fn().mockResolvedValue(
      anthropicResponse({
        insights: [
          {
            id: selected[0]?.id,
            headline: "Call 3 conversion prospects",
            why: "3 people have reached the supplied threshold.",
            action: "Contact all 3 today",
          },
        ],
      }),
    );
    const result = await synthesizeBriefing(selected, [], {
      fetchImpl,
      env: {
        ANTHROPIC_API_KEY: "unit-test-placeholder",
        ANTHROPIC_MODEL: "test-model",
      },
    });
    expect(result.status).toBe("generated");
    expect(result.costUsd).toBeCloseTo((100 * 15 + 20 * 75) / 1_000_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]?.content).not.toContain("private-name-must-not-leave");
    expect(body.messages[0]?.content).not.toContain("private@example.test");
  });

  it("rejects invented digits, retries once, then returns deterministic fallback", async () => {
    const selected = [candidate("hooked:conversion_opportunity", "conversion", 225)];
    const fetchImpl = vi.fn().mockImplementation(async () =>
      anthropicResponse({
        insights: [
          {
            id: selected[0]?.id,
            headline: "Call 999 prospects",
            why: "There are 999 opportunities.",
            action: "Contact 999 today",
          },
        ],
      }),
    );
    const result = await synthesizeBriefing(selected, [], {
      fetchImpl,
      env: { ANTHROPIC_API_KEY: "unit-test-placeholder" },
    });
    expect(result.status).toBe("fallback");
    expect(result.output).toEqual({
      insights: [
        expect.objectContaining({
          id: "hooked:conversion_opportunity",
          headline_facts: { people: 3 },
        }),
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function generationPool(options: { red?: boolean } = {}): {
  pool: Queryable;
  sql: string[];
} {
  const sql: string[] = [];
  const selected = candidate("hooked:conversion_opportunity", "conversion", 225);
  return {
    sql,
    pool: {
      query: async (text, values = []) => {
        sql.push(text);
        if (text.includes("business_date") && text.includes("from public.locations")) {
          return { rows: [{ business_date: "2026-07-18" }] };
        }
        if (text.includes("from public.ai_artifacts")) return { rows: [] };
        if (text.includes("with latest_per_entity")) {
          return {
            rows: [
              options.red
                ? {
                    red: true,
                    drift_rows: 1,
                    drift_count: 4,
                    reconciliation_ids: [RECONCILIATION],
                    sync_entities: [],
                  }
                : {
                    red: false,
                    drift_rows: 0,
                    drift_count: 0,
                    reconciliation_ids: [],
                    sync_entities: [],
                  },
            ],
          };
        }
        if (text.includes("with tenant_clock")) return { rows: [selected] };
        if (text.includes("from public.metric_definitions")) return { rows: [] };
        if (text.includes("insert into public.ai_artifacts")) {
          return {
            rows: [
              {
                id: ARTIFACT,
                tenant_id: TENANT,
                kind: "briefing",
                generated_for: "2026-07-18",
                status: values[2],
                prompt_version: 1,
                model: values[4],
                input: JSON.parse(String(values[5])) as unknown,
                input_hash: values[6],
                output: JSON.parse(String(values[7])) as unknown,
                cost_usd: values[8],
                error: values[9],
                created_at: "2026-07-18 10:00:00+00",
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
  };
}

describe("daily generation orchestration", () => {
  it("is idempotent for the studio-local business date", async () => {
    const existing = {
      id: ARTIFACT,
      tenant_id: TENANT,
      kind: "briefing",
      generated_for: "2026-07-18",
      status: "generated",
      prompt_version: 1,
      model: "test-model",
      input: { candidates: [] },
      input_hash: "existing-hash",
      output: { insights: [] },
      cost_usd: 0,
      error: null,
      created_at: "2026-07-18 10:00:00+00",
    };
    const sql: string[] = [];
    const pool: Queryable = {
      query: async (text) => {
        sql.push(text);
        return text.includes("from public.locations")
          ? { rows: [{ business_date: "2026-07-18" }] }
          : { rows: [existing] };
      },
    };
    await expect(runBriefing(pool, TENANT, { env: {} })).resolves.toEqual(existing);
    expect(sql).toHaveLength(2);
    expect(sql.some((text) => text.includes("with latest_per_entity"))).toBe(false);
  });

  it("stores fallback without calling Anthropic when the API key is absent", async () => {
    const fake = generationPool();
    const fetchImpl = vi.fn();
    const artifact = await runBriefing(fake.pool, TENANT, { fetchImpl, env: {} });
    expect(artifact.status).toBe("fallback");
    expect(artifact.error).toBe("ANTHROPIC_API_KEY is not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses on red reconciliation before candidate generation or any Anthropic call", async () => {
    const fake = generationPool({ red: true });
    const fetchImpl = vi.fn();
    const artifact = await runBriefing(fake.pool, TENANT, {
      fetchImpl,
      env: { ANTHROPIC_API_KEY: "unit-test-placeholder" },
    });
    expect(artifact.status).toBe("refused");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.sql.some((text) => text.includes("with tenant_clock"))).toBe(false);
  });
});
