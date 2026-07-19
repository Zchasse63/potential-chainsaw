// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EnvelopeMeta, MemberScheduleItem } from "@kelo/contracts";
import {
  SchedulePage,
  type ScheduleLoadResult,
} from "../src/components/schedule-page.jsx";

/**
 * The public session list renders ONLY through the DataBoundary provenance
 * contract (invariant #3) — these tests pin the ready / empty / error states
 * against the shared boundary, with the exact envelope the SSR loader emits.
 */

afterEach(cleanup);

const META: EnvelopeMeta = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "member-schedule:v1",
  correlation_id: "corr-test-1",
};

const OPEN_SESSION = {
  session_id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
  offering_name: "Sauna + Plunge",
  starts_at: "2026-07-20T07:30:00.000Z",
  ends_at: "2026-07-20T08:15:00.000Z",
  capacity: 8,
  available: 3,
  readiness_ok: true,
  credit_cost: 1,
};

const FULL_SESSION = {
  ...OPEN_SESSION,
  session_id: "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e",
  offering_name: "Contrast Therapy",
  starts_at: "2026-07-20T09:00:00.000Z",
  ends_at: "2026-07-20T09:45:00.000Z",
  available: 0,
};

function okResult(sessions: MemberScheduleItem[]): ScheduleLoadResult {
  return {
    ok: true,
    envelope: { data: sessions, meta: META },
    timeZone: "Europe/Dublin",
  };
}

describe("SchedulePage (public, read-only)", () => {
  it("ready: lists sessions with availability, credit cost, and the honest full state", () => {
    render(
      <SchedulePage result={okResult([OPEN_SESSION, FULL_SESSION])} onRefresh={vi.fn()} />,
    );

    expect(screen.getByText("Sauna + Plunge")).toBeTruthy();
    expect(screen.getByText("Contrast Therapy")).toBeTruthy();
    expect(screen.getByText("3 of 8 spots left")).toBeTruthy();
    // available === 0 → the waitlist affordance, never a fake "book" button.
    expect(screen.getByText("Full — waitlist available")).toBeTruthy();
    expect(screen.getAllByText("1 credit")).toHaveLength(2);
    // No booking actions exist in this unit (W8-3 lands the flow).
    expect(screen.queryByRole("button", { name: /book/i })).toBeNull();
  });

  it("empty: explains the emptiness is real (the studio's live book)", () => {
    render(<SchedulePage result={okResult([])} onRefresh={vi.fn()} />);

    expect(screen.getByText("No sessions in the next two weeks")).toBeTruthy();
    expect(screen.getByText(/live book/)).toBeTruthy();
  });

  it("error: the boundary shows consequence + retry, not data", () => {
    const onRefresh = vi.fn();
    render(
      <SchedulePage
        result={{ ok: false, error: { kind: "http_error", message: "HTTP 500" } }}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("This data didn't load")).toBeTruthy();
    expect(screen.getByText(/Nothing was booked or changed/)).toBeTruthy();
    expect(screen.queryByText("Sauna + Plunge")).toBeNull();
  });

  it("provenance defect: an ok result WITHOUT meta is refused, never rendered", () => {
    const broken = {
      ok: true,
      envelope: { data: [OPEN_SESSION] }, // no meta — a provenance violation
      timeZone: "Europe/Dublin",
    } as unknown as ScheduleLoadResult;
    render(<SchedulePage result={broken} onRefresh={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toMatch(/provenance record is missing/);
    expect(screen.queryByText("Sauna + Plunge")).toBeNull();
  });
});
