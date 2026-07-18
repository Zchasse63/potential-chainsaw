import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createGlofoxProcessors } from "../src/glofox/processors.js";
import { processPersonDelete } from "../src/people/delete.js";
import { processPersonExport } from "../src/people/export.js";
import { runRetentionSweep } from "../src/retention/sweep.js";
import type { JobRow, Queryable } from "../src/processors.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXPORT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const migration = readFileSync(
  new URL("../../supabase/migrations/20260718210100_0025_data_rights.sql", import.meta.url),
  "utf8",
);

function job(kind: string, payload: Record<string, unknown>): JobRow {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    tenant_id: TENANT,
    kind,
    payload,
    priority: 100,
    run_after: "2026-07-18T00:00:00.000Z",
    status: "running",
    attempts: 1,
    max_attempts: 5,
    lease_until: null,
    locked_by: "test",
    last_error: null,
    idempotency_key: null,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
  };
}

describe("retention.sweep", () => {
  it("uses the matrix cutoffs, scrubs old comms, deletes old AI, and never mutates ledgers", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: Queryable = {
      query: async (text, values) => {
        calls.push({ text, values });
        if (text.includes("from public.retention_policies")) {
          return {
            rows: [
              { data_class: "comms_content", retention_days: 730, action: "scrub_body", version: 1, tenant_id: null },
              { data_class: "ai_artifacts", retention_days: 365, action: "delete", version: 1, tenant_id: null },
              { data_class: "raw_payloads", retention_days: 1095, action: "delete", version: 1, tenant_id: null },
              { data_class: "import_quarantine", retention_days: 365, action: "delete", version: 1, tenant_id: null },
              { data_class: "webhook_events", retention_days: 180, action: "delete", version: 1, tenant_id: null },
              { data_class: "reconciliations", retention_days: 730, action: "delete", version: 1, tenant_id: null },
            ],
          };
        }
        return { rows: [{ touched: values?.[1] === "comms_content" ? 2 : 1 }] };
      },
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const summary = await runRetentionSweep(pool, TENANT);
    expect(summary.touched.comms_content).toBe(2);
    const comms = calls.find((call) => call.values?.[1] === "comms_content");
    expect(comms?.values).toEqual([TENANT, "comms_content", 730, "scrub_body"]);
    const ai = calls.find((call) => call.values?.[1] === "ai_artifacts");
    expect(ai?.values).toEqual([TENANT, "ai_artifacts", 365, "delete"]);

    const mutationSql = calls
      .map((call) => call.text)
      .filter((text) => /\b(update|delete)\b/i.test(text))
      .join("\n");
    for (const protectedTable of [
      "credit_ledger",
      "person_relationship_log",
      "audit_events",
      "communication_consents",
      "briefing_feedback",
      "campaign_attributions",
    ]) {
      expect(mutationSql).not.toContain(protectedTable);
      expect(migration).not.toMatch(
        new RegExp(`(?:delete\\s+from|update)\\s+public\\.${protectedTable}\\b`, "i"),
      );
    }
    expect(migration).toContain("created_at < now() - (p_retention_days * interval '1 day')");
    expect(migration).toContain("fetched_at < now() - (p_retention_days * interval '1 day')");
    info.mockRestore();
  });

  it("is registered and daily-deduped in the sync-all fan-out", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: Queryable = {
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const processors = createGlofoxProcessors({ now: () => new Date("2026-07-18T12:00:00Z") });
    expect(processors["retention.sweep"]).toBeTypeOf("function");
    expect(processors["person.delete"]).toBeTypeOf("function");
    expect(processors["person.export"]).toBeTypeOf("function");
    await processors["glofox.sync.all"]!(job("glofox.sync.all", {}), {
      pool,
      workerId: "test",
    });
    const fanout = calls.find((call) => call.text.includes("retention_job"));
    expect(fanout?.values).toContain("retention.sweep");
    expect(fanout?.values).toContain(`retention.sweep:${TENANT}:2026-07-18`);
  });
});

describe("person.delete", () => {
  it("calls the tenant-bound pseudonymization RPC with worker payload actor/reason", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: Queryable = {
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    await processPersonDelete(
      job("person.delete", { person_id: PERSON, actor_id: ACTOR, reason: "requested" }),
      { pool, workerId: "test" },
    );
    expect(calls).toEqual([
      expect.objectContaining({ values: [TENANT, PERSON, ACTOR, "requested"] }),
    ]);
    expect(calls[0]?.text).toContain("app.pseudonymize_person");
  });
});

describe("person.export", () => {
  it("assembles all subject sections with row counts and a seven-day ready window", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: Queryable = {
      query: async (text, values) => {
        calls.push({ text, values });
        if (text.includes("set status = 'running'")) {
          return { rows: [{ id: EXPORT, subject_person_id: PERSON, status: "running" }] };
        }
        if (text.includes("select p.* from public.people")) {
          return {
            rows: [{
              id: PERSON,
              tenant_id: TENANT,
              external_ref: "gfx-person",
              first_name: "Subject",
              email: "subject@example.com",
              membership_type: "Unlimited",
              membership_status: "active",
              user_membership_id: "mem-1",
              membership_started_at: "2026-01-01T00:00:00Z",
            }],
          };
        }
        if (text.includes("from public.glofox_bookings")) return { rows: [{ id: "booking" }] };
        if (text.includes("from public.glofox_transactions")) return { rows: [{ id: "tx" }] };
        if (text.includes("coalesce(sum(cl.delta)")) return { rows: [{ balance: 3, next_expiry: null }] };
        if (text.includes("from public.credit_ledger")) return { rows: [{ id: "credit" }] };
        if (text.includes("from public.comms_log")) return { rows: [{ id: "message" }] };
        if (text.includes("from public.communication_consents")) return { rows: [{ id: "consent" }] };
        if (text.includes("from public.segment_assignments")) return { rows: [{ id: "segment" }] };
        if (text.includes("from public.person_relationship_log")) return { rows: [{ id: "relationship" }] };
        return { rows: [] };
      },
    };

    await processPersonExport(
      job("person.export", { export_id: EXPORT, person_id: PERSON, actor_id: ACTOR }),
      { pool, workerId: "test" },
    );

    const ready = calls.find((call) => call.text.includes("set status = 'ready'"));
    expect(ready?.text).toContain("interval '7 days'");
    const artifact = JSON.parse(String(ready?.values?.[2])) as Record<string, unknown>;
    expect(Object.keys(artifact)).toEqual(expect.arrayContaining([
      "people",
      "memberships",
      "bookings",
      "transactions",
      "credit_ledger",
      "credit_balance",
      "comms_log",
      "communication_consents",
      "segment_assignments",
      "person_relationship_log",
    ]));
    expect(artifact["people"]).toMatchObject({ email: "subject@example.com" });
    const counts = JSON.parse(String(ready?.values?.[3])) as Record<string, number>;
    expect(counts).toMatchObject({ people: 1, memberships: 1, bookings: 1, transactions: 1 });
  });
});
