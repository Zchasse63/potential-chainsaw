import { describe, expect, it } from "vitest";
import { glofoxCreditSchema, glofoxCreditsResponseSchema } from "@kelo/contracts";
import { MAPPER_VERSION, mapCredit } from "../../src/mappers/credits.js";
import { CREDITS_MAPPER_VERSION } from "../../src/index.js";
import { loadSample } from "../helpers.js";

/**
 * mapCredit against the PINNED SAMPLES (docs/glofox/samples/credits.get.*.json)
 * — parsed through the contracts schema, then mapped. NO network, ever.
 */

const CTX = {
  tenantId: "00000000-0000-0000-0000-0000000000aa",
  personId: "00000000-0000-0000-0000-0000000000bb",
};

/** Minimal schema-valid credit for synthetic cases (overridable). */
function creditRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "credit-1",
    namespace: "ns",
    branch_id: "branch-1",
    user_id: "user-1",
    membership_id: "membership-1",
    model: "programs",
    num_sessions: 4,
    available: 2,
    active: true,
    bookings: ["booking-a", "booking-b"],
    start_date: 1783310400,
    created: 1783310400,
    modified: 1783390902,
    type: "usercredit",
    ...overrides,
  };
}

describe("mapCredit — pinned samples", () => {
  it("nonempty sample → grant row with NULL expires_at (sample omits end_date), no debits", () => {
    const sample = glofoxCreditsResponseSchema.parse(loadSample("credits.get.nonempty.json"));
    expect(sample.data).toHaveLength(1);

    // num_sessions 1, available 1 → consumed 0 → grant only, no quarantine.
    const result = mapCredit(sample.data[0]!, CTX);
    expect(result.quarantine).toHaveLength(0);
    expect(result.rows).toHaveLength(1);

    const grant = result.rows[0]!;
    expect(grant).toMatchObject({
      tenant_id: CTX.tenantId,
      person_id: CTX.personId,
      entry_type: "grant",
      delta: 1,
      expires_at: null, // absent end_date = no_expiry (the degraded rule, README §5)
      source: "glofox",
      external_ref: "6a4c62b6bab17ce8bf020c70",
      booking_external_ref: null,
      reason: null,
      actor_user_id: null,
    });
    expect(grant.grant_external_ref).toBeUndefined(); // debits only
  });

  it("empty sample → no rows, no quarantine", () => {
    const sample = glofoxCreditsResponseSchema.parse(loadSample("credits.get.json"));
    expect(sample.data).toHaveLength(0);
    const results = sample.data.map((c) => mapCredit(c, CTX));
    expect(results.flatMap((r) => r.rows)).toHaveLength(0);
    expect(results.flatMap((r) => r.quarantine)).toHaveLength(0);
  });
});

describe("mapCredit — debit derivation", () => {
  it("bookings[] length == consumed → one debit per consuming booking id", () => {
    const credit = glofoxCreditSchema.parse(creditRaw()); // 4 granted, 2 left, 2 bookings
    const result = mapCredit(credit, CTX);
    expect(result.quarantine).toHaveLength(0);

    const [grant, ...debits] = result.rows;
    expect(grant!.entry_type).toBe("grant");
    expect(grant!.delta).toBe(4);
    expect(debits).toHaveLength(2);
    expect(debits.map((d) => d.booking_external_ref)).toEqual(["booking-a", "booking-b"]);
    for (const d of debits) {
      expect(d.entry_type).toBe("debit");
      expect(d.delta).toBe(-1);
      expect(d.external_ref).toBeNull(); // the unique index keys grants/expires only
      expect(d.grant_external_ref).toBe("credit-1"); // sync layer joins grant_id
      expect(d.person_id).toBe(CTX.personId);
      expect(d.source).toBe("glofox");
    }
  });

  it("end_date present → grant.expires_at carries it", () => {
    const credit = glofoxCreditSchema.parse(
      creditRaw({ available: 4, bookings: [], end_date: 1786000000 }),
    );
    const result = mapCredit(credit, CTX);
    expect(result.rows[0]!.expires_at).toEqual(new Date(1786000000 * 1000));
  });

  it("bookings[] length ≠ consumed → ONE aggregate debit + quarantine, never a guess", () => {
    const credit = glofoxCreditSchema.parse(
      creditRaw({ num_sessions: 4, available: 1, bookings: ["booking-a"] }),
    );
    const result = mapCredit(credit, CTX);

    const debits = result.rows.filter((r) => r.entry_type === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      delta: -3, // consumed = 4 − 1
      booking_external_ref: null,
      grant_external_ref: "credit-1",
    });
    expect(debits[0]!.reason).toContain("attribution unknown");

    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]).toMatchObject({
      entity: "credits",
      external_ref: "credit-1",
      reason: "credit consumption mismatch: granted 4 available 1 bookings 1",
    });
  });

  it("consumed == 0 but bookings listed → contradictory: quarantine, no debit", () => {
    const credit = glofoxCreditSchema.parse(
      creditRaw({ num_sessions: 1, available: 1, bookings: ["booking-a"] }),
    );
    const result = mapCredit(credit, CTX);
    expect(result.rows.filter((r) => r.entry_type === "debit")).toHaveLength(0);
    expect(result.rows.filter((r) => r.entry_type === "grant")).toHaveLength(1);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]!.reason).toBe(
      "credit consumption mismatch: granted 1 available 1 bookings 1",
    );
  });
});

describe("mapCredit — nonsensical values quarantine the whole pack, no rows", () => {
  it.each([
    ["available > num_sessions", { num_sessions: 2, available: 5, bookings: [] }],
    ["negative counts", { num_sessions: -1, available: 0, bookings: [] }],
    [
      "zero granted (delta 0 would break the ledger CHECK)",
      { num_sessions: 0, available: 0, bookings: [] },
    ],
  ])("%s", (_label, overrides) => {
    const credit = glofoxCreditSchema.parse(creditRaw(overrides));
    const result = mapCredit(credit, CTX);
    expect(result.rows).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]!.entity).toBe("credits");
    expect(result.quarantine[0]!.reason).toContain("nonsensical credit values");
  });

  it("missing _id → quarantine ('missing external id'), no rows", () => {
    const credit = glofoxCreditSchema.parse(creditRaw({ _id: "" }));
    const result = mapCredit(credit, CTX);
    expect(result.rows).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]).toMatchObject({
      entity: "credits",
      external_ref: null,
      reason: "missing external id",
    });
  });
});

describe("mapCredit — invariants", () => {
  it("mappers NEVER emit 'adjust' (a human act — reason + actor mandatory)", () => {
    const scenarios = [
      creditRaw(),
      creditRaw({ num_sessions: 4, available: 1, bookings: ["booking-a"] }),
      creditRaw({ num_sessions: 2, available: 5, bookings: [] }),
      creditRaw({ available: 4, bookings: [], end_date: 1786000000 }),
    ];
    for (const raw of scenarios) {
      const result = mapCredit(glofoxCreditSchema.parse(raw), CTX);
      for (const row of result.rows) {
        expect(row.entry_type).not.toBe("adjust");
        expect(["grant", "debit"]).toContain(row.entry_type);
      }
    }
  });

  it("MAPPER_VERSION is exported (= 1) via the module and the package barrel", () => {
    expect(MAPPER_VERSION).toBe(1);
    expect(CREDITS_MAPPER_VERSION).toBe(MAPPER_VERSION);
  });
});
