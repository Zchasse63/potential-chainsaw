import { describe, expect, it } from "vitest";
import { glofoxBookingsResponseSchema, type GlofoxBooking } from "@kelo/contracts";
import { MAPPER_VERSION, mapBooking } from "../../src/mappers/bookings.js";
import type { MapperContext } from "../../src/mappers/facts-types.js";
import { loadSample } from "../helpers.js";

/**
 * Phase 1 · unit 3 — bookings → glofox_bookings. Pinned sample parsed through
 * the contracts boundary, then mapped. NO network. The branch timezone
 * (America/New_York, pinned in branch.get.json) is what turns the vendor's
 * ISO-ish wall-time strings into instants.
 */
const ctx: MapperContext = { tenantId: "tenant-test", timezone: "America/New_York" };

function sampleBookings(): GlofoxBooking[] {
  return glofoxBookingsResponseSchema.parse(loadSample("bookings.get.limit3.json")).data;
}

describe("mapBooking (glofox_bookings)", () => {
  it("maps all 3 pinned bookings, zero quarantine, statuses known", () => {
    const bookings = sampleBookings();
    expect(bookings).toHaveLength(3);
    for (const booking of bookings) {
      const { row, quarantine } = mapBooking(booking, ctx);
      expect(quarantine).toHaveLength(0);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("BOOKED"); // raw status, one of the known five
      expect(row?.person_external_ref).toBe(booking.user_id);
      expect(row?.session_external_ref).toBe(booking.event_id);
      expect(row?.tenant_id).toBe(ctx.tenantId);
    }
  });

  it("converts branch-local wall times with the branch timezone, not UTC", () => {
    const [first] = sampleBookings().map((booking) => mapBooking(booking, ctx).row);
    // "2023-12-17 07:00:00" in America/New_York (EST, UTC−5 in December).
    expect(first?.time_start?.toISOString()).toBe("2023-12-17T12:00:00.000Z");
    expect(first?.time_finish?.toISOString()).toBe("2023-12-17T13:00:00.000Z");
    expect(first?.canceled_at).toBeNull();
  });

  it("maps the policy/channel facts verbatim (origin null passes through)", () => {
    const [first] = sampleBookings().map((booking) => mapBooking(booking, ctx).row);
    expect(first?.attended).toBe(true);
    expect(first?.paid).toBe(false);
    expect(first?.payment_method).toBeNull();
    expect(first?.is_first).toBe(true);
    expect(first?.is_from_waiting_list).toBe(false);
    expect(first?.is_late_cancellation).toBe(false);
    expect(first?.guest_bookings).toBe(0);
    expect(first?.booking_type).toBe("events");
    expect(first?.model).toBe("events");
    expect(first?.origin).toBeNull(); // must-answer #2: kept even when null
  });

  it("unknown status → row STILL emitted verbatim PLUS a quarantine row (visible AND flagged)", () => {
    const base = sampleBookings()[0];
    const mutated = { ...base, status: "NO_SHOW" } as unknown as GlofoxBooking;
    const { row, quarantine } = mapBooking(mutated, ctx);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("NO_SHOW"); // raw string kept; generated status_known=false at the DB
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.entity).toBe("glofox_bookings");
    expect(quarantine[0]?.external_ref).toBe(mutated._id);
    expect(quarantine[0]?.reason).toBe("unknown booking status: NO_SHOW");
  });

  it("missing _id or user_id → quarantine, no row", () => {
    const noId = { ...sampleBookings()[0], _id: "" } as GlofoxBooking;
    const noPerson = { ...sampleBookings()[0], user_id: " " } as GlofoxBooking;
    const idResult = mapBooking(noId, ctx);
    const personResult = mapBooking(noPerson, ctx);
    expect(idResult.row).toBeNull();
    expect(idResult.quarantine[0]?.reason).toContain("missing booking _id");
    expect(personResult.row).toBeNull();
    expect(personResult.quarantine[0]?.reason).toContain("missing booking user_id");
    expect(personResult.quarantine[0]?.external_ref).toBe(noPerson._id);
  });

  it("unparseable timestamp → field nulled AND quarantined, row still emitted", () => {
    const mutated = {
      ...sampleBookings()[0],
      time_start: "not a timestamp",
    } as GlofoxBooking;
    const { row, quarantine } = mapBooking(mutated, ctx);
    expect(row).not.toBeNull();
    expect(row?.time_start).toBeNull();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reason).toContain("unparseable booking time_start");
  });

  it("is deterministic and versioned", () => {
    const [booking] = sampleBookings();
    expect(mapBooking(booking as GlofoxBooking, ctx)).toEqual(
      mapBooking(booking as GlofoxBooking, ctx),
    );
    expect(MAPPER_VERSION).toBe(1);
  });
});
