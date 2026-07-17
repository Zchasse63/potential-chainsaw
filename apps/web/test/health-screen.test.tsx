// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { HealthScreen } from "../src/screens/health-screen.jsx";

afterEach(cleanup);

/**
 * A valid /health envelope (mirrors apps/api/src/routes/health.ts): two
 * entities at different buckets, EMPTY runs + alerts (phase-0 reality), one
 * authority row. meta.stale is true because bookings is critical — the API
 * marks the whole report stale when any entity is.
 */
const HEALTH_ENVELOPE = {
  data: {
    freshness: [
      {
        entity: "members",
        health_state: "healthy",
        last_success_at: "2026-07-17T11:55:00.000Z",
        minutes_stale: 5,
        bucket: "synced",
      },
      {
        entity: "bookings",
        health_state: "stale",
        last_success_at: "2026-07-17T07:00:00.000Z",
        minutes_stale: 300,
        bucket: "critical",
      },
    ],
    sync_runs: [],
    alerts: [],
    authority: [
      {
        capability: "people",
        read_source: "glofox",
        write_source: "glofox",
        state: "glofox_authoritative",
        cadence: "hourly",
        cutover: null,
      },
    ],
  },
  meta: {
    as_of: "2026-07-17T12:00:00.000Z",
    source: "native",
    stale: true,
    definition_version: null,
    correlation_id: "corr-health-1",
  },
};

function successQuery(data: unknown): BoundaryQuery {
  return { status: "success", data, isRefetching: false, refetch: vi.fn() };
}

describe("HealthScreen with a mocked valid envelope", () => {
  it("renders each entity with its freshness chip, health state, and last success", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("members")).toBeDefined();
    expect(screen.getByText("SYNCED 5M")).toBeDefined();
    expect(screen.getByText("healthy")).toBeDefined();
    expect(screen.getByText("bookings")).toBeDefined();
    expect(screen.getByText("STALE 4H+")).toBeDefined();
    expect(screen.getByText("stale")).toBeDefined();
    expect(screen.getAllByText(/Last success /).length).toBe(2);
  });

  it("labels the page with provenance and one timezone label", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("Live in Kelo")).toBeDefined();
    expect(screen.getByText(/Times shown in /)).toBeDefined();
  });

  it("shows the stale banner because meta.stale is true", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("Some data below is stale")).toBeDefined();
  });

  it("renders the honest empty states — expected empties, not failures", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("No imports yet — the import pipeline lands in phase 1")).toBeDefined();
    expect(screen.getByText("No open alerts.")).toBeDefined();
  });

  it("never fabricates the trust streak — an em-dash plus why", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("—")).toBeDefined();
    expect(screen.getByText("Days since an unchecked figure")).toBeDefined();
    expect(screen.getByText(/tracking begins with imports/i)).toBeDefined();
  });

  it("renders the authority matrix with the countdown-to-cutover narrative", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("people")).toBeDefined();
    expect(screen.getByText("Glofox authoritative")).toBeDefined();
    expect(screen.getByText(/no cutover scheduled/)).toBeDefined();
  });
});
