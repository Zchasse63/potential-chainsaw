// sample: docs/glofox/samples/memberships.get.json
import { glofoxPlanTypeSchema, type GlofoxMembership, type GlofoxPlan } from "@kelo/contracts";
import type { MapperContext, MapperResult, PlanCatalogRow, QuarantineRow } from "./types.js";
import { hasExternalId } from "./types.js";

/**
 * Membership → plan_catalog rows (migration 0008; README §5). One row per
 * plans[] entry — a Glofox membership contains multiple purchasable plans, and
 * plan `code` (numeric, stored as text) is what joins transactions'
 * metadata.plan_code. PURE — no DB, no network, no clock.
 *
 * kelo_type stays NULL: it is the owner's A8 catalog mapping (phase-1 owner
 * task), edited through the column-list update grant — mappers never guess it.
 */
export const MAPPER_VERSION = 1;

/**
 * Calendar duration → days for the catalog's int column. day/week are exact;
 * month/year are APPROXIMATIONS (30/365) — the raw plan object preserves the
 * exact unit + count, and unrecognized units map to NULL, never a guess.
 */
const DURATION_UNIT_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function durationDays(plan: GlofoxPlan): number | null {
  const unit = plan.duration_time_unit;
  const count = plan.duration_time_unit_count;
  if (unit == null || count == null) return null;
  const perUnit = DURATION_UNIT_DAYS[unit];
  return perUnit == null ? null : perUnit * count;
}

/** Total sessions a plan grants across its credits[] scopes; null when the
 * plan grants no countable credits (time/unlimited plans have credits: []). */
function creditsGranted(plan: GlofoxPlan): number | null {
  if (plan.credits.length === 0) return null;
  return plan.credits.reduce((sum, credit) => sum + credit.num_sessions, 0);
}

export function mapMembership(
  m: GlofoxMembership,
  ctx: MapperContext,
): MapperResult<PlanCatalogRow> {
  // The membership _id is the import key (unique with plan_code) — quarantine
  // the whole item if it is missing.
  if (!hasExternalId(m._id)) {
    return {
      rows: [],
      quarantine: [
        { entity: "memberships", external_ref: null, payload: m, reason: "missing external id" },
      ],
    };
  }

  const rows: PlanCatalogRow[] = [];
  const quarantine: QuarantineRow[] = [];

  for (const plan of m.plans) {
    // Unknown plan types QUARANTINE that plan entry, never silently map
    // (invariant #8) — the known plans in the same membership still import.
    // Defense in depth: the contract enum already rejects these at parse.
    const type = glofoxPlanTypeSchema.safeParse(plan.type);
    if (!type.success) {
      quarantine.push({
        entity: "memberships",
        external_ref: m._id,
        payload: { membership_id: m._id, plan },
        reason: `unknown plan type: ${String(plan.type)}`,
      });
      continue;
    }

    rows.push({
      tenant_id: ctx.tenantId,
      external_ref: m._id,
      name: m.name,
      description: m.description,
      active: m.active,
      plan_code: String(plan.code),
      plan_name: plan.name,
      price: plan.price,
      glofox_type: type.data,
      credits_granted: creditsGranted(plan),
      duration_days: durationDays(plan),
      kelo_type: null,
      raw: plan,
    });
  }

  return { rows, quarantine };
}
