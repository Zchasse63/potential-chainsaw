import { describe, expect, it } from "vitest";
import { glofoxEventsResponseSchema, type GlofoxEventSession } from "@kelo/contracts";
import { MAPPER_VERSION, mapEvent } from "../../src/mappers/sessions.js";
import type { MapperContext } from "../../src/mappers/facts-types.js";
import { loadSample } from "../helpers.js";

/**
 * Phase 1 · unit 3 — events → glofox_sessions. Parses the pinned live sample
 * through the contracts boundary first (the only way mapper inputs are
 * produced), then maps. NO network.
 */
const ctx: MapperContext = { tenantId: "tenant-test", timezone: "America/New_York" };

function sampleEvents(): GlofoxEventSession[] {
  return glofoxEventsResponseSchema.parse(loadSample("events.get.limit2.json")).data;
}

describe("mapEvent (glofox_sessions)", () => {
  it("maps both pinned events with zero quarantine", () => {
    const events = sampleEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      const { row, quarantine } = mapEvent(event, ctx);
      expect(quarantine).toHaveLength(0);
      expect(row).not.toBeNull();
      expect(row?.tenant_id).toBe(ctx.tenantId);
      expect(row?.external_ref).toBe(event._id);
    }
  });

  it("maps capacity/booked/waiting and the schedule facts verbatim", () => {
    const [first, second] = sampleEvents().map((event) => mapEvent(event, ctx).row);
    // int-unix time_start is already a Date from the Zod boundary.
    expect(first?.time_start).toEqual(new Date(1784379600 * 1000));
    expect(first?.duration_minutes).toBe(60);
    expect(first?.capacity).toBe(12);
    expect(first?.booked_count).toBe(1);
    expect(first?.waiting_count).toBe(0);
    expect(first?.program_external_ref).toBe("66421c02f59eba9ee50cca11");
    expect(first?.trainer_refs).toEqual(["69a46e379382b7401708b953"]);
    expect(first?.facility_ref).toBe("654e7d3dc8a12ada310de141");
    expect(first?.is_private).toBe(false);
    expect(first?.status).toBe("AVAILABLE");
    expect(second?.time_start).toEqual(new Date(1784383200 * 1000));
    expect(second?.capacity).toBe(12);
    expect(second?.booked_count).toBe(0);
    expect(second?.waiting_count).toBe(0);
  });

  it("keeps the source object as raw (glofox_raw is the immutable record; this is the projection)", () => {
    const [event] = sampleEvents();
    const { row } = mapEvent(event as GlofoxEventSession, ctx);
    expect(row?.raw).toBe(event);
  });

  it("missing _id → quarantine, no row (no stable identity to upsert)", () => {
    const broken = { ...sampleEvents()[0], _id: "" } as GlofoxEventSession;
    const { row, quarantine } = mapEvent(broken, ctx);
    expect(row).toBeNull();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.entity).toBe("glofox_sessions");
    expect(quarantine[0]?.reason).toContain("_id");
    expect(quarantine[0]?.payload).toBe(broken);
  });

  it("is deterministic and versioned", () => {
    const [event] = sampleEvents();
    expect(mapEvent(event as GlofoxEventSession, ctx)).toEqual(
      mapEvent(event as GlofoxEventSession, ctx),
    );
    expect(MAPPER_VERSION).toBe(1);
  });
});
