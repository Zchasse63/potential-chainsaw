import { describe, expect, it } from "vitest";
import { expandScheduleRule, localWallTimeToInstant } from "../src/data-scheduling.js";

/**
 * Phase 4.2 — SCHEDULING AUTHORING, the DST correctness proof (the headline of
 * the unit). Session times are absolute instants computed from a local wall
 * time interpreted IN THE LOCATION TIMEZONE, so 09:00 is 09:00 local on BOTH
 * sides of a DST transition even though the UTC offset shifts. Pure functions —
 * no DB, no network.
 */

const NY = "America/New_York";

const TEMPLATE = { duration_minutes: 60, default_capacity: 12 };
const RESOURCE = { capacity: 20 };
const baseRule = {
  id: "rule-1",
  offering_template_id: "tpl-1",
  resource_id: "res-1",
  timezone: NY,
  active: true as const,
};

describe("localWallTimeToInstant — DST-correct wall-time → absolute instant", () => {
  it("resolves 09:00 to the correct UTC instant on both sides of a DST change", () => {
    // Winter: EST = UTC-5 → 09:00 local = 14:00Z. Summer: EDT = UTC-4 → 13:00Z.
    expect(localWallTimeToInstant("2025-01-15", "09:00", NY).toISOString()).toBe(
      "2025-01-15T14:00:00.000Z",
    );
    expect(localWallTimeToInstant("2025-07-15", "09:00", NY).toISOString()).toBe(
      "2025-07-15T13:00:00.000Z",
    );
  });

  it("rejects a wall time that does not exist because of spring-forward", () => {
    // 2025-03-09 02:30 America/New_York never happens (clocks jump 02:00→03:00).
    expect(() => localWallTimeToInstant("2025-03-09", "02:30", NY)).toThrowError(
      /does not exist|nonexistent/i,
    );
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() => localWallTimeToInstant("2025-01-15", "09:00", "Not/AZone")).toThrowError(
      /timezone/i,
    );
  });
});

describe("expandScheduleRule — occurrences carry the correct absolute instant across DST", () => {
  it("a daily 09:00 rule spanning spring-forward keeps 09:00 local each day", () => {
    // Spring-forward is 2025-03-09. Days before are EST (14:00Z), on/after EDT (13:00Z).
    const sessions = expandScheduleRule(
      { ...baseRule, rrule: "FREQ=DAILY", local_start_time: "09:00", start_date: "2025-03-07", end_date: "2025-03-11" },
      TEMPLATE,
      RESOURCE,
      { from: "2025-03-07", to: "2025-03-11" },
    );
    const byDay = Object.fromEntries(sessions.map((s) => [s.starts_at.slice(0, 10), s.starts_at]));
    expect(byDay["2025-03-07"]).toBe("2025-03-07T14:00:00.000Z"); // EST
    expect(byDay["2025-03-08"]).toBe("2025-03-08T14:00:00.000Z"); // EST
    expect(byDay["2025-03-10"]).toBe("2025-03-10T13:00:00.000Z"); // EDT (offset shifted)
    expect(byDay["2025-03-11"]).toBe("2025-03-11T13:00:00.000Z"); // EDT
    // 03-09 exists at 09:00 (the skipped hour is 02:00-03:00, not 09:00) → EDT.
    expect(byDay["2025-03-09"]).toBe("2025-03-09T13:00:00.000Z");
  });

  it("a daily 09:00 rule spanning fall-back keeps 09:00 local each day", () => {
    // Fall-back is 2025-11-02. Days before are EDT (13:00Z), on/after EST (14:00Z).
    const sessions = expandScheduleRule(
      { ...baseRule, rrule: "FREQ=DAILY", local_start_time: "09:00", start_date: "2025-10-31", end_date: "2025-11-04" },
      TEMPLATE,
      RESOURCE,
      { from: "2025-10-31", to: "2025-11-04" },
    );
    const byDay = Object.fromEntries(sessions.map((s) => [s.starts_at.slice(0, 10), s.starts_at]));
    expect(byDay["2025-11-01"]).toBe("2025-11-01T13:00:00.000Z"); // EDT
    expect(byDay["2025-11-03"]).toBe("2025-11-03T14:00:00.000Z"); // EST
  });

  it("sets ends_at = starts_at + duration and carries the resource capacity", () => {
    const [session] = expandScheduleRule(
      { ...baseRule, rrule: "FREQ=DAILY", local_start_time: "09:00", start_date: "2025-06-02", end_date: "2025-06-02" },
      { duration_minutes: 90, default_capacity: null },
      RESOURCE,
      { from: "2025-06-02", to: "2025-06-02" },
    );
    expect(session?.starts_at).toBe("2025-06-02T13:00:00.000Z");
    expect(session?.ends_at).toBe("2025-06-02T14:30:00.000Z"); // +90 min
    expect(session?.status).toBe("draft");
  });
});

describe("expandScheduleRule — RRULE subset (weekly BYDAY, interval, count, horizon)", () => {
  it("FREQ=WEEKLY;BYDAY=MO,WE,FR emits only those weekdays", () => {
    const sessions = expandScheduleRule(
      { ...baseRule, rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", local_start_time: "06:00", start_date: "2025-06-02", end_date: "2025-06-08" },
      TEMPLATE,
      RESOURCE,
      { from: "2025-06-02", to: "2025-06-08" },
    );
    const days = sessions.map((s) => s.starts_at.slice(0, 10)).sort();
    // Week of Mon 2025-06-02: Mon 02, Wed 04, Fri 06.
    expect(days).toEqual(["2025-06-02", "2025-06-04", "2025-06-06"]);
  });

  it("FREQ=DAILY;COUNT=3 stops after three occurrences", () => {
    const sessions = expandScheduleRule(
      { ...baseRule, rrule: "FREQ=DAILY;COUNT=3", local_start_time: "08:00", start_date: "2025-06-02", end_date: null },
      TEMPLATE,
      RESOURCE,
      { from: "2025-06-02", to: "2025-06-30" },
    );
    expect(sessions).toHaveLength(3);
  });

  it("rejects an unsupported FREQ and an over-long horizon", () => {
    expect(() =>
      expandScheduleRule(
        { ...baseRule, rrule: "FREQ=MONTHLY", local_start_time: "08:00", start_date: "2025-06-02", end_date: null },
        TEMPLATE,
        RESOURCE,
        { from: "2025-06-02", to: "2025-06-03" },
      ),
    ).toThrowError(/FREQ=DAILY or FREQ=WEEKLY/i);

    expect(() =>
      expandScheduleRule(
        { ...baseRule, rrule: "FREQ=DAILY", local_start_time: "08:00", start_date: "2025-06-02", end_date: null },
        TEMPLATE,
        RESOURCE,
        { from: "2025-06-02", to: "2025-09-02" }, // > 8 weeks
      ),
    ).toThrowError(/8 weeks|horizon/i);
  });

  it("an inactive rule expands to nothing", () => {
    expect(
      expandScheduleRule(
        { ...baseRule, active: false as unknown as true, rrule: "FREQ=DAILY", local_start_time: "08:00", start_date: "2025-06-02", end_date: "2025-06-05" },
        TEMPLATE,
        RESOURCE,
        { from: "2025-06-02", to: "2025-06-05" },
      ),
    ).toHaveLength(0);
  });
});
