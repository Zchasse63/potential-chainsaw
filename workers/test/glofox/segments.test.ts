import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { processors, type TickCtx } from "../../src/processors.js";
import {
  createGlofoxProcessors,
  DERIVE_RELATIONSHIPS_KIND,
  DERIVE_SEGMENTS_KIND,
  GLOFOX_SYNC_ALL_KIND,
  GLOFOX_SYNC_ALL_KINDS,
  GLOFOX_SYNC_KINDS,
} from "../../src/glofox/processors.js";
import { callsMatching, createFakePool, makeJob, TENANT } from "./helpers.js";

const MIGRATION = readFileSync(
  new URL("../../../supabase/migrations/20260718130100_0018_segment_engine.sql", import.meta.url),
  "utf8",
);

const PAYMENT_RISK_RULE = MIGRATION.slice(
  MIGRATION.indexOf("-- §1 row 1: payment_risk"),
  MIGRATION.indexOf("-- §1 row 2: at_risk"),
);
const COLD_LEAD_RULE = MIGRATION.slice(
  MIGRATION.indexOf("-- §1 row 11: cold_lead"),
  MIGRATION.indexOf("-- §1 row 12: high_value"),
);
const HIGH_VALUE_RULE = MIGRATION.slice(
  MIGRATION.indexOf("-- §1 row 12: high_value"),
  MIGRATION.indexOf("-- §1 row 13: active_recurring"),
);

function makeCtx(pool: ReturnType<typeof createFakePool>): TickCtx {
  return { pool, workerId: "w-test" };
}

describe("derive.segments processor", () => {
  it("is registered and invokes one tenant-scoped recompute", async () => {
    expect(processors[DERIVE_SEGMENTS_KIND]).toBeTypeOf("function");

    const pool = createFakePool({
      respond: (text) =>
        text.includes("app.recompute_segments")
          ? { rows: [{ run_id: "segment-run-1" }] }
          : undefined,
    });
    const processor = createGlofoxProcessors()[DERIVE_SEGMENTS_KIND]!;
    await processor(makeJob({ kind: DERIVE_SEGMENTS_KIND }), makeCtx(pool));

    const calls = callsMatching(pool.calls, "app.recompute_segments");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("select app.recompute_segments($1::uuid) as run_id");
    expect(calls[0]?.values).toEqual([TENANT]);
    expect(pool.calls).toHaveLength(1);
  });

  it("fails loudly without a tenant", async () => {
    const pool = createFakePool();
    const processor = createGlofoxProcessors()[DERIVE_SEGMENTS_KIND]!;

    await expect(
      processor(makeJob({ kind: DERIVE_SEGMENTS_KIND, tenant_id: null }), makeCtx(pool)),
    ).rejects.toThrow(/requires a tenant/);
    expect(pool.calls).toHaveLength(0);
  });

  it("fails the job when SQL closes an error run and returns no id", async () => {
    const pool = createFakePool({
      respond: (text) =>
        text.includes("app.recompute_segments") ? { rows: [{ run_id: null }] } : undefined,
    });
    const processor = createGlofoxProcessors()[DERIVE_SEGMENTS_KIND]!;

    await expect(processor(makeJob({ kind: DERIVE_SEGMENTS_KIND }), makeCtx(pool))).rejects.toThrow(
      /segment recompute failed/,
    );
    expect(callsMatching(pool.calls, "app.recompute_segments")).toHaveLength(1);
  });

  it("fans out segments after relationships without dropping existing jobs", async () => {
    const pool = createFakePool();
    const processor = createGlofoxProcessors({
      now: () => new Date("2026-07-18T13:01:00.000Z"),
    })[GLOFOX_SYNC_ALL_KIND]!;

    await processor(makeJob({ kind: GLOFOX_SYNC_ALL_KIND }), makeCtx(pool));

    expect(GLOFOX_SYNC_ALL_KINDS.slice(0, GLOFOX_SYNC_KINDS.length)).toEqual(GLOFOX_SYNC_KINDS);
    expect(GLOFOX_SYNC_ALL_KINDS.indexOf(DERIVE_SEGMENTS_KIND)).toBe(
      GLOFOX_SYNC_ALL_KINDS.indexOf(DERIVE_RELATIONSHIPS_KIND) + 1,
    );

    const orderedBatch = pool.calls.at(-1);
    expect(orderedBatch?.text).toMatch(/deletion_job[\s\S]+relationship_job[\s\S]+segment_job/);
    expect(orderedBatch?.values?.[4]).toBe(DERIVE_RELATIONSHIPS_KIND);
    expect(orderedBatch?.values?.[8]).toBe(DERIVE_SEGMENTS_KIND);
  });
});

describe("segment engine SQL contract", () => {
  it("seeds all 13 versioned definitions in priority order", () => {
    const keys = [
      "payment_risk",
      "at_risk",
      "credits_expiring",
      "hooked",
      "trial_graduated",
      "stale_credits",
      "win_back",
      "aggregator_regular",
      "cooling",
      "new",
      "cold_lead",
      "high_value",
      "active_recurring",
    ];

    keys.forEach((key, index) => {
      expect(MIGRATION).toContain(`('${key}', 1, ${index + 1},`);
    });
    expect(MIGRATION).toContain("unique (key, version)");
    expect(MIGRATION).toContain("v_rule_version constant int := 1");
  });

  it("pins the confirmed threshold and hygiene defaults in params", () => {
    expect(MIGRATION).toContain('\'{"days":21,"cooldown_days":7}\'::jsonb');
    expect(MIGRATION).toContain('\'{"visits":3,"days":30,"cooldown_days":7}\'::jsonb');
    expect(MIGRATION).toContain('\'{"days":30,"cooldown_days":7}\'::jsonb');
    expect(MIGRATION).toContain('\'{"days":14,"cooldown_days":7}\'::jsonb');
    expect(MIGRATION).toContain('\'{"top_percent":10,"cooldown_days":7}\'::jsonb');
  });

  it("makes assignments append-only even for service_role", () => {
    expect(MIGRATION).toMatch(
      /revoke update, delete on public\.segment_assignments\s+from anon, authenticated, service_role/,
    );
    expect(MIGRATION).toContain("grant insert on public.segment_assignments to service_role");
  });

  it("computes active_recurring last from this run's complement", () => {
    const active = MIGRATION.indexOf("-- §1 row 13: active_recurring");
    const highValue = MIGRATION.indexOf("-- §1 row 12: high_value");
    const closeRun = MIGRATION.indexOf("set status = 'success'", active);

    expect(active).toBeGreaterThan(highValue);
    expect(closeRun).toBeGreaterThan(active);
    expect(MIGRATION.slice(active, closeRun)).toContain(
      "sa.segment_key in ('payment_risk', 'at_risk', 'cooling')",
    );
  });

  it("uses Kelo created_at for cold-lead age and source_created_at only for launch exclusion", () => {
    expect(COLD_LEAD_RULE).toContain(
      "(p.created_at at time zone v_timezone)::date <= v_today - 14",
    );
    expect(COLD_LEAD_RULE).toContain("(p.source_created_at at time zone v_timezone)::date");
    expect(COLD_LEAD_RULE).toContain(">= (v_launch_at at time zone v_timezone)::date - 90");
    expect(COLD_LEAD_RULE.match(/p\.source_created_at/g)).toHaveLength(2);
    expect(COLD_LEAD_RULE).toContain("from public.sync_runs sr");
  });

  it("uses both real payment-risk feeds", () => {
    expect(PAYMENT_RISK_RULE).toContain("gt.transaction_status = 'ERROR'");
    expect(PAYMENT_RISK_RULE).toContain("gt.glofox_event_class = 'subscription_payment_failed'");
    expect(PAYMENT_RISK_RULE).toMatch(
      /gt\.transaction_status = 'ERROR'\s+or gt\.glofox_event_class = 'subscription_payment_failed'/,
    );
  });

  it("excludes active relationship-override people from high-value ranking", () => {
    expect(HIGH_VALUE_RULE).toContain("join public.relationship_overrides ro");
    expect(HIGH_VALUE_RULE).toContain("and ro.active");
    expect(HIGH_VALUE_RULE).toContain("select 1 from override_people op");
    expect(HIGH_VALUE_RULE).toContain("gt.transaction_status = 'PAID'");
  });

  it("returns only the highest-priority assignment from the latest successful run", () => {
    expect(MIGRATION).toContain("create or replace function public.segment_current");
    expect(MIGRATION).toContain("and sr.status = 'success'");
    expect(MIGRATION).toContain("partition by sa.person_id");
    expect(MIGRATION).toContain("order by sd.priority, sa.segment_key");
    expect(MIGRATION).toContain("where r.queue_rank = 1");
    expect(MIGRATION).toContain("security invoker");
  });
});
