import { describe, expect, it } from "vitest";
import {
  glofoxBookingsResponseSchema,
  glofoxBranchSchema,
  glofoxCreditsResponseSchema,
  glofoxEventsResponseSchema,
  glofoxMembersResponseSchema,
  glofoxMembershipsResponseSchema,
  glofoxTransactionsReportSchema,
} from "../src/index.js";
import { loadSample } from "./helpers.js";

/**
 * Phase-0 gate (CLAUDE.md: "every mapper cites a pinned sample"): every consumed
 * Glofox endpoint has a pinned contract — its Zod schema MUST parse the
 * live-verified, PII-redacted sample in docs/glofox/samples/. If Glofox drifts,
 * this is where it surfaces first.
 */
const sampleContracts = [
  ["members.get.limit2.json", glofoxMembersResponseSchema],
  ["memberships.get.json", glofoxMembershipsResponseSchema],
  ["credits.get.nonempty.json", glofoxCreditsResponseSchema],
  ["credits.get.json", glofoxCreditsResponseSchema],
  ["bookings.get.limit3.json", glofoxBookingsResponseSchema],
  ["analytics.report.30d.json", glofoxTransactionsReportSchema],
  ["branch.get.json", glofoxBranchSchema],
  ["events.get.limit2.json", glofoxEventsResponseSchema],
] as const;

describe("pinned Glofox sample contracts", () => {
  for (const [file, schema] of sampleContracts) {
    it(`parses docs/glofox/samples/${file}`, () => {
      expect(() => schema.parse(loadSample(file))).not.toThrow();
    });
  }

  it("members: unix timestamps become Date at the boundary", () => {
    const parsed = glofoxMembersResponseSchema.parse(loadSample("members.get.limit2.json"));
    const first = parsed.data[0];
    expect(first).toBeDefined();
    expect(first?.created).toBeInstanceOf(Date);
    expect(first?.modified).toBeInstanceOf(Date);
    expect(first?.membership.start_date).toBeInstanceOf(Date);
    expect(parsed.total_count).toBe(1366);
  });

  it("credits: the empty pack list parses to data: [] (not an error)", () => {
    const parsed = glofoxCreditsResponseSchema.parse(loadSample("credits.get.json"));
    expect(parsed.data).toHaveLength(0);
    expect(parsed.total_count).toBe(0);
    expect(parsed.has_more).toBe(false);
  });

  it("credits: absent end_date survives as undefined (callers treat as no_expiry)", () => {
    const parsed = glofoxCreditsResponseSchema.parse(loadSample("credits.get.nonempty.json"));
    const pack = parsed.data[0];
    expect(pack).toBeDefined();
    expect(pack?.end_date).toBeUndefined();
    expect(pack?.available).toBe(1);
  });

  it("analytics: 56 rows, all three live glofox_event values present", () => {
    const parsed = glofoxTransactionsReportSchema.parse(loadSample("analytics.report.30d.json"));
    const rows = parsed.TransactionsList.details;
    expect(rows).toHaveLength(56);
    const events = new Set(rows.map((row) => row.StripeCharge.metadata.glofox_event));
    expect(events).toEqual(new Set(["subscription_payment", "invoice_payment", "book_class"]));
    const statuses = new Set(rows.map((row) => row.StripeCharge.transaction_status));
    expect(statuses).toEqual(new Set(["PAID", "ERROR", "REFUNDED"]));
  });

  it("bookings: style B envelope carries success + meta.totalCount", () => {
    const parsed = glofoxBookingsResponseSchema.parse(loadSample("bookings.get.limit3.json"));
    expect(parsed.success).toBe(true);
    expect(parsed.meta.totalCount).toBe(6);
    expect(parsed.data).toHaveLength(3);
  });

  it("branch: exposes the studio-day timezone + currency", () => {
    const parsed = glofoxBranchSchema.parse(loadSample("branch.get.json"));
    expect(parsed.address.timezone_id).toBe("America/New_York");
    expect(parsed.address.timezone_name).toBe("America/New_York");
    expect(parsed.address.currency).toBe("USD");
  });

  it("events: capacity fields parse (size/booked/waiting)", () => {
    const parsed = glofoxEventsResponseSchema.parse(loadSample("events.get.limit2.json"));
    const first = parsed.data[0];
    expect(first).toBeDefined();
    expect(first?.size).toBe(12);
    expect(first?.booked).toBe(1);
    expect(first?.waiting).toBe(0);
    expect(first?.time_start).toBeInstanceOf(Date);
  });
});
