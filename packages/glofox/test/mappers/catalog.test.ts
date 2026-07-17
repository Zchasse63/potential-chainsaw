import { describe, expect, it } from "vitest";
import {
  glofoxMembershipsResponseSchema,
  type GlofoxMembership,
  type GlofoxPlan,
} from "@kelo/contracts";
import { MAPPER_VERSION, mapMembership } from "../../src/mappers/catalog.js";
import { CATALOG_MAPPER_VERSION } from "../../src/index.js";
import { loadSample } from "../helpers.js";

/**
 * mapMembership against the PINNED SAMPLE (docs/glofox/samples/memberships.get.json)
 * — parsed through the contracts schema, then mapped. NO network, ever.
 */

const TENANT = "00000000-0000-0000-0000-0000000000aa";

function sampleMemberships(): GlofoxMembership[] {
  return glofoxMembershipsResponseSchema.parse(loadSample("memberships.get.json")).data;
}

describe("mapMembership — pinned memberships sample", () => {
  const memberships = sampleMemberships();
  const results = memberships.map((m) => mapMembership(m, { tenantId: TENANT }));
  const allRows = results.flatMap((r) => r.rows);

  it("6 catalog items parse; one row per (membership, plan) pair — 10 total", () => {
    expect(memberships).toHaveLength(6);
    expect(results.map((r) => r.rows.length)).toEqual([1, 2, 2, 1, 1, 3]);
    expect(allRows).toHaveLength(10);
    expect(results.every((r) => r.quarantine.length === 0)).toBe(true);
  });

  it("every known glofox_type maps; kelo_type stays NULL (owner A8)", () => {
    expect(new Set(allRows.map((r) => r.glofox_type))).toEqual(
      new Set(["num_classes", "time_classes", "time"]),
    );
    expect(allRows.every((r) => r.kelo_type === null)).toBe(true);
    // The unique key (tenant_id, external_ref, plan_code) holds pairwise.
    expect(new Set(allRows.map((r) => `${r.external_ref}:${r.plan_code}`)).size).toBe(10);
  });

  it("row fields: numeric code as text, price, credits, duration, raw plan object", () => {
    // Drop-in: membership with a single num_classes plan.
    const dropIn = results[0]!.rows[0]!;
    expect(dropIn).toMatchObject({
      tenant_id: TENANT,
      external_ref: "69d80c439f4158716c0068de",
      name: memberships[0]!.name,
      description: memberships[0]!.description,
      active: true,
      plan_code: "1775766556749",
      plan_name: memberships[0]!.plans[0]!.name,
      price: 40,
      glofox_type: "num_classes",
      credits_granted: 1,
      duration_days: null,
      kelo_type: null,
    });
    expect(dropIn.raw).toEqual(memberships[0]!.plans[0]);

    // Monthly 4/8-class (time_classes, month × 1 → 30 days, credits 4/8).
    const monthly = results[2]!.rows;
    expect(monthly.map((r) => r.credits_granted)).toEqual([4, 8]);
    expect(monthly.every((r) => r.glofox_type === "time_classes")).toBe(true);
    expect(monthly.every((r) => r.duration_days === 30)).toBe(true);

    // 2-week intro (time, week × 2 → 14 days, no countable credits).
    const intro = results[4]!.rows[0]!;
    expect(intro.glofox_type).toBe("time");
    expect(intro.duration_days).toBe(14);
    expect(intro.credits_granted).toBeNull();

    // Gift-card membership: 3 plans (1/4/8 credits).
    expect(results[5]!.rows.map((r) => r.credits_granted)).toEqual([1, 4, 8]);
  });
});

describe("mapMembership — synthetic edge cases", () => {
  it("unknown plan type → that plan entry quarantined ('unknown plan type: X'), known ones kept", () => {
    const m = sampleMemberships()[1]!; // two known num_classes plans
    const broken: GlofoxMembership = {
      ...m,
      plans: [{ ...m.plans[0]!, type: "mystery" } as unknown as GlofoxPlan, m.plans[1]!],
    };
    const result = mapMembership(broken, { tenantId: TENANT });

    expect(result.rows).toHaveLength(1); // the known plan still imports
    expect(result.rows[0]!.glofox_type).toBe("num_classes");

    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]).toMatchObject({
      entity: "memberships",
      external_ref: m._id,
      reason: "unknown plan type: mystery",
    });
  });

  it("missing membership _id → the whole item quarantines, no rows", () => {
    const broken = { ...sampleMemberships()[0]!, _id: "" };
    const result = mapMembership(broken, { tenantId: TENANT });
    expect(result.rows).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]).toMatchObject({
      entity: "memberships",
      external_ref: null,
      reason: "missing external id",
    });
  });

  it("MAPPER_VERSION is exported (= 1) via the module and the package barrel", () => {
    expect(MAPPER_VERSION).toBe(1);
    expect(CATALOG_MAPPER_VERSION).toBe(MAPPER_VERSION);
  });
});
