// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { HealthScreen } from "../src/screens/health-screen.jsx";

// The quarantine card navigates with TanStack <Link>; stub it as an anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

/**
 * A valid /health envelope (mirrors apps/api/src/routes/health.ts): two
 * entities at different buckets, EMPTY runs + alerts (phase-0 reality), one
 * authority row, two open quarantine causes, one drift reconciliation.
 * meta.stale is true because bookings is critical — the API marks the whole
 * report stale when any entity is.
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
    quarantine: {
      open_count: 3,
      by_cause: [
        { entity: "transactions", reason: "missing_namespace", open_count: 2 },
        { entity: "plans", reason: "unknown_glofox_event", open_count: 1 },
      ],
    },
    reconciliation: {
      pending: false,
      recent: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          entity: "transactions",
          window_start: "2026-07-16T00:00:00.000Z",
          window_end: "2026-07-17T00:00:00.000Z",
          glofox_count: 41,
          kelo_count: 40,
          glofox_sum: 1234.5,
          kelo_sum: 1204.5,
          drift_count: 1,
          drift_sum: 30,
          status: "drift",
          detail: {},
          checked_at: "2026-07-17T11:00:00.000Z",
          created_at: "2026-07-17T11:00:00.000Z",
        },
      ],
    },
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
    // Page header + the reconciliation comparison label both carry it.
    expect(screen.getAllByText("Live in Kelo").length).toBeGreaterThan(0);
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

  it("renders the quarantine summary with open count, top causes, and the /import link", () => {
    render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("Quarantine")).toBeDefined();
    expect(screen.getByText("missing_namespace")).toBeDefined();
    expect(screen.getByText(/Review 3 open exceptions/)).toBeDefined();
  });

  it("renders the reconciliation section with the drift pill and the comparison label", () => {
    const { container } = render(<HealthScreen query={successQuery(HEALTH_ENVELOPE)} />);
    expect(screen.getByText("Reconciliation")).toBeDefined();
    expect(screen.getByText(/compared against native Kelo/)).toBeDefined();
    const pill = screen.getByTestId("status-pill-drift");
    expect(pill.textContent).toContain("Drift");
    expect(pill.getAttribute("data-marker")).toBe("▲");
    // Drift is highlighted with shape + weight, not color alone.
    expect(container.querySelector(".text-warning-emphasis")).not.toBeNull();
  });

  it("shows the honest pending state when the reconciliation table hasn't landed", () => {
    const pending = {
      ...HEALTH_ENVELOPE,
      data: {
        ...HEALTH_ENVELOPE.data,
        reconciliation: { pending: true, recent: [] },
      },
    };
    render(<HealthScreen query={successQuery(pending)} />);
    expect(screen.getByText("Reconciliation runs when the import pipeline lands")).toBeDefined();
  });

  it("shows the clean quarantine state when nothing is open", () => {
    const clean = {
      ...HEALTH_ENVELOPE,
      data: {
        ...HEALTH_ENVELOPE.data,
        quarantine: { open_count: 0, by_cause: [] },
      },
    };
    render(<HealthScreen query={successQuery(clean)} />);
    expect(screen.getByText("No open exceptions — the import is clean")).toBeDefined();
  });
});
