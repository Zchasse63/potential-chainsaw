import { describe, expect, it } from "vitest";
import { glofoxBookingSchema, glofoxMemberSchema } from "../src/index.js";
import { loadSample } from "./helpers.js";

/**
 * Population variants the pinned 2-member sample could not show — found by the
 * LIVE backfill 2026-07-18 (644 + 49 + 40 + 8 quarantined rows). Each variant
 * here is a real shape observed in production; these tests keep the contract
 * tolerant of them forever. (Plan §4: "single samples hide optional
 * fields/variants" — this is that lesson, learned once, pinned as tests.)
 */

function sampleMember(): Record<string, unknown> {
  const page = loadSample("members.get.limit2.json") as { data: Record<string, unknown>[] };
  return JSON.parse(JSON.stringify(page.data[0])) as Record<string, unknown>;
}

function sampleBooking(): Record<string, unknown> {
  const page = loadSample("bookings.get.limit3.json") as { data: Record<string, unknown>[] };
  return JSON.parse(JSON.stringify(page.data[0])) as Record<string, unknown>;
}

describe("live population variants stay parseable", () => {
  it("member without membership.user_membership_id (644 live rows)", () => {
    const m = sampleMember();
    delete (m["membership"] as Record<string, unknown>)["user_membership_id"];
    const parsed = glofoxMemberSchema.parse(m);
    expect(parsed.membership.user_membership_id ?? null).toBeNull();
  });

  it("member with null membership.start_date (49 live rows)", () => {
    const m = sampleMember();
    (m["membership"] as Record<string, unknown>)["start_date"] = null;
    const parsed = glofoxMemberSchema.parse(m);
    expect(parsed.membership.start_date ?? null).toBeNull();
  });

  it("member with null phone (8 live rows)", () => {
    const m = sampleMember();
    m["phone"] = null;
    const parsed = glofoxMemberSchema.parse(m);
    expect(parsed.phone ?? null).toBeNull();
  });

  it("member with absent membership.status", () => {
    const m = sampleMember();
    delete (m["membership"] as Record<string, unknown>)["status"];
    const parsed = glofoxMemberSchema.parse(m);
    expect(parsed.membership.status ?? null).toBeNull();
  });

  it("booking with PHP-style empty-array metadata (40 live rows)", () => {
    const b = sampleBooking();
    b["metadata"] = [];
    const parsed = glofoxBookingSchema.parse(b);
    expect(parsed.metadata ?? null).toBeNull();
  });
});
