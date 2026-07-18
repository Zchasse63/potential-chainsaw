import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createGlofoxProcessors,
  DERIVE_RELATIONSHIPS_KIND,
} from "../../src/glofox/processors.js";
import { processors, type TickCtx } from "../../src/processors.js";
import { callsMatching, createFakePool, makeJob, TENANT } from "./helpers.js";

const MIGRATION = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717170100_0012_relationship_typing.sql",
    import.meta.url,
  ),
  "utf8",
);

function makeCtx(pool: ReturnType<typeof createFakePool>): TickCtx {
  return { pool, workerId: "w-test" };
}

/**
 * PostgreSQL is deliberately absent from unit tests. These tests therefore
 * cover both sides of the contract without duplicating the derivation in TS:
 * the recording pool proves the worker emits only the batch RPC, while source
 * assertions pin each load-bearing branch in the SQL that actually owns it.
 */
describe("derive.relationships processor", () => {
  it("is registered and invokes one tenant-scoped SQL recompute", async () => {
    expect(processors[DERIVE_RELATIONSHIPS_KIND]).toBeTypeOf("function");

    const pool = createFakePool();
    const processor = createGlofoxProcessors()[DERIVE_RELATIONSHIPS_KIND]!;
    await processor(makeJob({ kind: DERIVE_RELATIONSHIPS_KIND }), makeCtx(pool));

    const calls = callsMatching(pool.calls, "app.recompute_all_relationships");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(
      "select app.recompute_all_relationships($1::uuid) as processed_count",
    );
    expect(calls[0]?.values).toEqual([TENANT]);
    expect(pool.calls).toHaveLength(1);
  });

  it("fails loudly for an unscoped job", async () => {
    const pool = createFakePool();
    const processor = createGlofoxProcessors()[DERIVE_RELATIONSHIPS_KIND]!;

    await expect(
      processor(makeJob({ kind: DERIVE_RELATIONSHIPS_KIND, tenant_id: null }), makeCtx(pool)),
    ).rejects.toThrow(/requires a tenant/);
    expect(pool.calls).toHaveLength(0);
  });
});

describe("relationship SQL rule-version 1 contract", () => {
  it("classifies a recent subscription_payment as recurring_member", () => {
    expect(MIGRATION).toContain("gt.glofox_event_class = 'subscription_payment'");
    expect(MIGRATION).toContain(
      "gt.transaction_created_at >= v_now - make_interval(days => 30 + v_grace_days)",
    );
    expect(MIGRATION).toContain(
      "v_holding_types := array_append(v_holding_types, 'recurring_member')",
    );
  });

  it("classifies positive unexpired credit balance as pack_holder", () => {
    expect(MIGRATION).toContain("from app.person_credit_balance(p_tenant, p_person) pcb");
    expect(MIGRATION).toContain("v_pack := v_credit_balance > 0");
    expect(MIGRATION).toContain(
      "v_holding_types := array_append(v_holding_types, 'pack_holder')",
    );
  });

  it("keeps member and pack facts concurrently while member wins precedence", () => {
    const recurringFact = MIGRATION.indexOf(
      "v_holding_types := array_append(v_holding_types, 'recurring_member')",
    );
    const packFact = MIGRATION.indexOf(
      "v_holding_types := array_append(v_holding_types, 'pack_holder')",
    );
    const recurringPrimary = MIGRATION.indexOf("v_primary := 'recurring_member'");
    const packPrimary = MIGRATION.indexOf("v_primary := 'pack_holder'");

    expect(recurringFact).toBeGreaterThan(-1);
    expect(packFact).toBeGreaterThan(recurringFact);
    expect(recurringPrimary).toBeGreaterThan(packFact);
    expect(packPrimary).toBeGreaterThan(recurringPrimary);
  });

  it("uses guest only for activity without a stronger fact", () => {
    expect(MIGRATION).toContain("if cardinality(v_holding_types) = 0 then");
    expect(MIGRATION).toContain("if v_has_activity then");
    expect(MIGRATION).toContain("v_holding_types := array_append(v_holding_types, 'guest')");
    expect(MIGRATION).toContain("v_primary := 'guest'");
  });

  it("uses lead when no activity or stronger evidence exists", () => {
    expect(MIGRATION).toContain("v_holding_types := array_append(v_holding_types, 'lead')");
    expect(MIGRATION).toContain("v_primary := 'lead'");
  });

  it("logs exactly the pack_holder to recurring_member primary transition path", () => {
    expect(MIGRATION).toContain("if v_old_primary is distinct from v_primary then");
    expect(MIGRATION).toContain("insert into public.person_relationship_log");
    expect(MIGRATION).toMatch(/v_old_primary,\s+v_primary,\s+v_primary_basis/s);
  });

  it("guards both the people update and log insert for idempotent re-runs", () => {
    const guard = MIGRATION.indexOf("if v_old_primary is distinct from v_primary then");
    const peopleUpdate = MIGRATION.indexOf("update public.people p", guard);
    const logInsert = MIGRATION.indexOf("insert into public.person_relationship_log", guard);
    const guardEnd = MIGRATION.indexOf("end if;", logInsert);

    expect(guard).toBeGreaterThan(-1);
    expect(peopleUpdate).toBeGreaterThan(guard);
    expect(logInsert).toBeGreaterThan(peopleUpdate);
    expect(guardEnd).toBeGreaterThan(logInsert);
  });
});
