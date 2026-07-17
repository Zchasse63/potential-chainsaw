import { describe, expect, it } from "vitest";
import { freshnessBucket, minutesSince } from "../src/freshness.js";

// Design-guide freshness thresholds: live <1m · synced ≥1m · stale ≥2h (120m)
// · critical ≥4h (240m) · never-synced → unknown.
describe("freshnessBucket", () => {
  it("maps minutes-stale to the design-guide buckets", () => {
    expect(freshnessBucket(null)).toBe("unknown");
    expect(freshnessBucket(0)).toBe("live");
    expect(freshnessBucket(0.5)).toBe("live");
    expect(freshnessBucket(1)).toBe("synced");
    expect(freshnessBucket(119)).toBe("synced");
    expect(freshnessBucket(120)).toBe("stale");
    expect(freshnessBucket(239)).toBe("stale");
    expect(freshnessBucket(240)).toBe("critical");
    expect(freshnessBucket(10_000)).toBe("critical");
  });
});

describe("minutesSince", () => {
  it("returns whole minutes, null for absent/unparseable input", () => {
    const now = Date.parse("2026-07-17T20:00:00Z");
    expect(minutesSince(null, now)).toBeNull();
    expect(minutesSince("not-a-date", now)).toBeNull();
    expect(minutesSince("2026-07-17T19:30:00Z", now)).toBe(30);
    // Clock skew never yields negative staleness.
    expect(minutesSince("2026-07-17T21:00:00Z", now)).toBe(0);
  });
});
