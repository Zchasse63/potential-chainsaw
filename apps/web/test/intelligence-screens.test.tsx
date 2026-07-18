// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { BriefingArchiveScreen } from "../src/screens/briefing-archive-screen.jsx";
import { ScheduleScreen } from "../src/screens/schedule-screen.jsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

afterEach(cleanup);

const META = { as_of: "2026-07-18T18:00:00.000Z", source: "mixed", stale: false, definition_version: "1", correlation_id: "corr-intelligence" };
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

describe("ScheduleScreen", () => {
  it("labels tint as fill and discloses source sessions only after cell interaction", () => {
    render(<ScheduleScreen query={success({
      metric: "30-day fill",
      approximation: "Imported capacity",
      from: "2026-06-19",
      to: "2026-07-18",
      cells: [{ dow: 1, daypart: "morning", sessions: 1, booked: 3, capacity: 4, fill: 0.75, underlying_sessions: [{ session_id: "22222222-2222-4222-8222-222222222222", name: "Contrast", time_start: "2026-07-14T13:00:00.000Z", booked: 3, capacity: 4 }] }],
    })} />);
    expect(screen.getByRole("heading", { name: "30-day fill heatmap" })).toBeDefined();
    expect(screen.getByText(/It is fill, not demand/)).toBeDefined();
    expect(screen.queryByText("Contrast")).toBeNull();
    fireEvent.focus(screen.getByRole("gridcell", { name: /Mon Morning: 75% fill/ }));
    expect(screen.getByText("Contrast")).toBeDefined();
    expect(screen.getByText("3/4 booked")).toBeDefined();
  });
});

describe("BriefingArchiveScreen", () => {
  it("uses the shared generated and refused artifact renderers", () => {
    render(<BriefingArchiveScreen query={success({ artifacts: [
      { id: "33333333-3333-4333-8333-333333333333", generated_for: "2026-07-18", status: "generated", output: { insights: [{ id: "revenue:change", headline: "Review collected revenue", why: "Revenue facts are available.", action: "Open the report" }] } },
      { id: "44444444-4444-4444-8444-444444444444", generated_for: "2026-07-17", status: "refused", output: { insights: [], message: "source reconciliation is red", health: { reconciliation_ids: [], sync_entities: ["transactions"] } } },
    ] })} />);
    expect(screen.getByText("Review collected revenue")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /2026-07-17/ }));
    expect(screen.getByText(/Briefing paused: source reconciliation is red/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Open Health" }).getAttribute("href")).toBe("/health");
  });
});
