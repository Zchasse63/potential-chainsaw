import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGlofoxProcessors, DERIVE_RELATIONSHIPS_KIND } from "../../src/glofox/processors.js";
import { processors, type TickCtx } from "../../src/processors.js";
import { callsMatching, createFakePool, makeJob, TENANT } from "./helpers.js";

const MIGRATION = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717190100_0014_relationship_overrides.sql",
    import.meta.url,
  ),
  "utf8",
);

const RECURRING_RULE = MIGRATION.slice(
  MIGRATION.indexOf("v_recurring :="),
  MIGRATION.indexOf("if v_recurring then"),
);

const OVERRIDE_RULE = MIGRATION.slice(
  MIGRATION.indexOf("if not v_recurring then"),
  MIGRATION.indexOf("-- Positive UNEXPIRED credit balance"),
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

describe("relationship SQL rule-version 3 contract", () => {
  it("keeps the adjudication register narrow, audited, tenant-readable, and client-immutable", () => {
    expect(MIGRATION).toContain("check (forced_relationship in ('recurring_member'))");
    expect(MIGRATION).toContain("reason                text not null check (length(reason) >= 10)");
    expect(MIGRATION).toContain("approved_by           text not null");
    expect(MIGRATION).toMatch(
      /on public\.relationship_overrides \(tenant_id, person_external_ref\)\s+where active/,
    );
    expect(MIGRATION).toContain("tenant_id in (select app.current_tenant_ids())");
    expect(MIGRATION).toContain(
      "revoke insert, update, delete on public.relationship_overrides from authenticated",
    );
    expect(MIGRATION).toContain("grant select on public.relationship_overrides to authenticated");
  });

  it("ACTIVE + time classifies as recurring_member", () => {
    expect(MIGRATION).toContain("v_rule_version constant int := 3");
    expect(RECURRING_RULE).toContain("v_membership_status in ('ACTIVE', 'PAUSED')");
    expect(RECURRING_RULE).toContain("v_membership_type in ('time', 'time_classes')");
    expect(MIGRATION).toContain(
      "v_holding_types := array_append(v_holding_types, 'recurring_member')",
    );
  });

  it("ACTIVE + payg classifies as recurring_member through an A8 recurring catalog mapping", () => {
    expect(RECURRING_RULE).toContain("from public.plan_catalog pc");
    expect(RECURRING_RULE).toContain("pc.tenant_id = p_tenant");
    expect(RECURRING_RULE).toContain("pc.external_ref = v_user_membership_id");
    expect(RECURRING_RULE).toContain("pc.kelo_type in ('recurring', 'unlimited', 'intro')");
  });

  it("ACTIVE + payg without a recurring catalog mapping does not qualify", () => {
    expect(RECURRING_RULE).not.toContain("'payg'");
    expect(RECURRING_RULE).toMatch(/v_membership_type in \('time', 'time_classes'\)\s+or exists/s);
    expect(MIGRATION).toContain("if cardinality(v_holding_types) = 0 then");
    expect(MIGRATION).toContain("v_primary := 'guest'");
  });

  it("PAUSED + time_classes classifies as recurring_member", () => {
    expect(RECURRING_RULE).toContain("v_membership_status in ('ACTIVE', 'PAUSED')");
    expect(RECURRING_RULE).toContain("v_membership_type in ('time', 'time_classes')");
  });

  it("null/CANCELLED status does not qualify even with a subscription_payment", () => {
    expect(RECURRING_RULE).not.toContain("'CANCELLED'");
    expect(RECURRING_RULE).not.toContain("subscription_payment");
    expect(MIGRATION).toContain("gt.glofox_event_class = 'subscription_payment'");
    expect(MIGRATION).toContain("'corroborating_subscription_payment', v_subscription_id");
    expect(MIGRATION).toContain("'phase_1_rule', 'membership-status-based v2'");
  });

  it("ACTIVE payg + a matching active override adds recurring_member with visible evidence", () => {
    expect(OVERRIDE_RULE).toContain("from public.relationship_overrides ro");
    expect(OVERRIDE_RULE).toContain("where ro.tenant_id = p_tenant and ro.active");
    expect(OVERRIDE_RULE).toContain("ro.forced_relationship = 'recurring_member'");
    expect(OVERRIDE_RULE).toContain("v_recurring := true");
    expect(OVERRIDE_RULE).toContain("'override_id', v_override_id");
    expect(OVERRIDE_RULE).toContain("'override_reason', v_override_reason");
    expect(OVERRIDE_RULE).toContain("'membership_status', v_membership_status");
    expect(OVERRIDE_RULE).toContain("'membership_type', v_membership_type");
    expect(OVERRIDE_RULE).toContain("'phase_1_rule', 'owner-adjudication override v3'");
  });

  it("does not consult an override when the membership signal already qualifies", () => {
    const membershipBasis = MIGRATION.indexOf("'phase_1_rule', 'membership-status-based v2'");
    const overrideGuard = MIGRATION.indexOf("if not v_recurring then");
    const overrideSelect = MIGRATION.indexOf("from public.relationship_overrides ro");

    expect(membershipBasis).toBeGreaterThan(MIGRATION.indexOf("if v_recurring then"));
    expect(overrideGuard).toBeGreaterThan(membershipBasis);
    expect(overrideSelect).toBeGreaterThan(overrideGuard);
  });

  it("an inactive override has no effect", () => {
    expect(OVERRIDE_RULE).toMatch(/where ro\.tenant_id = p_tenant and ro\.active\s+and/s);
  });

  it("an override for a different external ref has no effect", () => {
    expect(OVERRIDE_RULE).toContain("ro.person_external_ref = any (v_external_refs)");
    expect(OVERRIDE_RULE).not.toContain("ro.person_external_ref is not null");
  });

  it("classifies positive unexpired credit balance as pack_holder", () => {
    expect(MIGRATION).toContain("from app.person_credit_balance(p_tenant, p_person) pcb");
    expect(MIGRATION).toContain("v_pack := v_credit_balance > 0");
    expect(MIGRATION).toContain("v_holding_types := array_append(v_holding_types, 'pack_holder')");
  });

  it("recurring_member still wins precedence over a concurrent pack", () => {
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
