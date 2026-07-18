import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, TENANT_B, USER_ID } from "./fakes.js";

const DEFINITION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const headers = { authorization: "Bearer good-token" };

function reportApp(role = "trainer") {
  const fake = fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
      metric_definitions: () => ({
        data: [
          {
            id: DEFINITION_ID,
            key: "collected_revenue",
            version: 1,
            definition: "Succeeded payments minus refunds.",
            notes: null,
            effective_from: "2026-07-18T12:01:00Z",
            created_at: "2026-07-18T12:01:00Z",
          },
        ],
      }),
    },
    {
      kpi_report_dates: () => ({
        data: [{ today: "2026-07-18", from_7d: "2026-07-12", from_30d: "2026-06-19" }],
      }),
      kpi_member_count: () => ({ data: 22 }),
      kpi_mrr: () => ({
        data: [{ mrr: 2310, contributing_members: 20, excluded_partner: 2 }],
      }),
      kpi_collected_revenue_totals: (params) => ({
        data: [
          params["p_from"] === "2026-07-12"
            ? { gross: 700, refunds: -25, net: 675, txn_count: 9 }
            : { gross: 3000, refunds: -100, net: 2900, txn_count: 41 },
        ],
      }),
      kpi_failed_payments: () => ({
        data: [{ failed_count: 3, failed_sum: 240, people: 2 }],
      }),
      kpi_credit_liability: () => ({
        data: [{ outstanding_credits: 44, est_liability: 880, approximate: true }],
      }),
      kpi_attendance: () => ({
        data: [
          {
            attended: 80,
            no_show: 5,
            late_cancel: 4,
            attendance_rate: 80 / 85,
            no_show_rate: 5 / 85,
          },
        ],
      }),
      kpi_collected_revenue: () => ({
        data: [{ day: "2026-07-18", gross: 125, refunds: -25, net: 100, txn_count: 3 }],
      }),
    },
  );
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
  });
  return { app, fake };
}

describe("GET /api/v1/reports/kpis", () => {
  it("returns SQL outputs untouched with v1 definition refs and resolved-tenant RPCs", async () => {
    const { app, fake } = reportApp();
    const res = await app.request("/api/v1/reports/kpis", {
      headers: { ...headers, "x-kelo-tenant": TENANT_B },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<
        string,
        {
          value: unknown;
          definition: { key: string; version: number };
          related_definitions?: Array<{ key: string; version: number }>;
        }
      >;
      meta: { source: string; definition_version: string };
    };

    expect(body.meta).toMatchObject({ source: "glofox", definition_version: "v1" });
    expect(Object.keys(body.data)).toEqual([
      "member_count",
      "mrr",
      "collected_7d",
      "collected_30d",
      "failed_payments",
      "credit_liability",
      "attendance_30d",
    ]);
    for (const field of Object.values(body.data)) {
      expect(field.definition.version).toBe(1);
      expect(field.definition.key).not.toBe("");
    }

    // Exact function payloads survive transport — no TypeScript arithmetic.
    expect(body.data["mrr"]?.value).toEqual({
      mrr: 2310,
      contributing_members: 20,
      excluded_partner: 2,
    });
    expect(body.data["mrr"]).toMatchObject({
      related_definitions: [{ key: "partner_invoiced_members", version: 1 }],
    });
    expect(body.data["collected_7d"]?.value).toEqual({
      gross: 700,
      refunds: -25,
      net: 675,
      txn_count: 9,
    });
    expect(body.data["credit_liability"]?.value).toEqual({
      outstanding_credits: 44,
      est_liability: 880,
      approximate: true,
    });
    expect(body.data["attendance_30d"]).toMatchObject({
      related_definitions: [{ key: "no_show_rate", version: 1 }],
    });

    const rpcCalls = fake.calls.filter((call) => call.method === "rpc");
    expect(rpcCalls.map((call) => call.table)).toEqual([
      "kpi_report_dates",
      "kpi_member_count",
      "kpi_mrr",
      "kpi_collected_revenue_totals",
      "kpi_collected_revenue_totals",
      "kpi_failed_payments",
      "kpi_credit_liability",
      "kpi_attendance",
    ]);
    for (const call of rpcCalls) {
      expect(call.args[0]).toMatchObject({ p_tenant: TENANT_A });
      expect(call.args[0]).not.toMatchObject({ p_tenant: TENANT_B });
    }
  });
});

describe("GET /api/v1/reports/revenue", () => {
  it("rejects invalid or reversed calendar dates with 422 before any KPI RPC", async () => {
    const { app, fake } = reportApp();
    const bad = await app.request("/api/v1/reports/revenue?from=2026-02-31&to=2026-03-01", {
      headers,
    });
    expect(bad.status).toBe(422);

    const reversed = await app.request("/api/v1/reports/revenue?from=2026-07-18&to=2026-07-01", {
      headers,
    });
    expect(reversed.status).toBe(422);
    expect(fake.calls.some((call) => call.method === "rpc")).toBe(false);
  });

  it("passes through the daily function rows and SQL-owned totals", async () => {
    const { app, fake } = reportApp();
    const res = await app.request("/api/v1/reports/revenue?from=2026-07-18&to=2026-07-18", {
      headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { daily: unknown; totals: unknown; definition: unknown };
    };
    expect(body.data).toEqual({
      daily: [{ day: "2026-07-18", gross: 125, refunds: -25, net: 100, txn_count: 3 }],
      totals: { gross: 3000, refunds: -100, net: 2900, txn_count: 41 },
      definition: { key: "collected_revenue", version: 1 },
    });
    for (const call of fake.calls.filter((entry) => entry.method === "rpc")) {
      expect(call.args[0]).toMatchObject({
        p_tenant: TENANT_A,
        p_from: "2026-07-18",
        p_to: "2026-07-18",
      });
    }
  });
});

describe("GET /api/v1/reports/definitions", () => {
  it("allows any active member role to read the seeded dictionary rows", async () => {
    const { app, fake } = reportApp("front_desk");
    const res = await app.request("/api/v1/reports/definitions", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { definitions: Array<{ key: string; version: number; definition: string }> };
      meta: { definition_version: string };
    };
    expect(body.data.definitions).toEqual([
      expect.objectContaining({
        key: "collected_revenue",
        version: 1,
        definition: "Succeeded payments minus refunds.",
      }),
    ]);
    expect(body.meta.definition_version).toBe("v1");
    expect(fake.calls).toContainEqual(
      expect.objectContaining({ table: "metric_definitions", method: "select" }),
    );
  });
});
