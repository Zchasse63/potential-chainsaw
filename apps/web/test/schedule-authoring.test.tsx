// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { ScheduleScreen } from "../src/screens/schedule-screen.jsx";
import type {
  Mutator,
  SchedulingActions,
  SchedulingOverview,
} from "../src/lib/scheduling.js";

vi.mock("../src/lib/telemetry.js", () => ({
  initTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const META = {
  as_of: "2026-07-18T18:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "scheduling:v1",
  correlation_id: "corr-scheduling",
};

function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

const HEATMAP = success({
  metric: "30-day fill",
  approximation: "Imported capacity",
  from: "2026-06-19",
  to: "2026-07-18",
  cells: [],
});

function fakeMutator<I>(): Mutator<I> {
  return { mutate: vi.fn(), pending: false };
}

function fakeActions(): SchedulingActions {
  return {
    createResource: fakeMutator(),
    updateResource: fakeMutator(),
    createTemplate: fakeMutator(),
    updateTemplate: fakeMutator(),
    setReadiness: fakeMutator(),
    createSession: fakeMutator(),
    updateSession: fakeMutator(),
    publish: fakeMutator(),
  };
}

const TZ = "America/New_York";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const PUBLISHED_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const RESOURCE_ID = "44444444-4444-4444-8444-444444444444";

// Sessions anchored to "now" so they land in the current studio week regardless
// of when the suite runs; the grid buckets by the same clock it renders with.
const NOW_ISO = new Date().toISOString();

function overview(overrides: Partial<SchedulingOverview> = {}): SchedulingOverview {
  return {
    timezone: TZ,
    from: "2026-07-08T00:00:00.000Z",
    to: "2026-08-05T00:00:00.000Z",
    resources: [
      { id: RESOURCE_ID, name: "Sauna A", kind: "room", capacity: 6, active: true, created_at: NOW_ISO },
    ],
    readiness: [],
    offering_templates: [
      { id: TEMPLATE_ID, name: "Contrast 50", duration_minutes: 50, default_capacity: 6, kelo_type: null, description: null, active: true, created_at: NOW_ISO },
    ],
    schedule_rules: [],
    sessions: [
      { id: DRAFT_ID, offering_template_id: TEMPLATE_ID, resource_id: RESOURCE_ID, starts_at: NOW_ISO, ends_at: NOW_ISO, capacity: 6, status: "draft", schedule_rule_id: null, created_by: null, published_at: null, created_at: NOW_ISO, updated_at: NOW_ISO },
      { id: PUBLISHED_ID, offering_template_id: TEMPLATE_ID, resource_id: RESOURCE_ID, starts_at: NOW_ISO, ends_at: NOW_ISO, capacity: 6, status: "published", schedule_rule_id: null, created_by: null, published_at: NOW_ISO, created_at: NOW_ISO, updated_at: NOW_ISO },
    ],
    ...overrides,
  };
}

function renderAuthoring(actions: SchedulingActions = fakeActions()) {
  render(
    <ScheduleScreen query={HEATMAP} canAuthor overviewQuery={success(overview())} actions={actions} />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Authoring" }));
  return actions;
}

describe("ScheduleScreen — authoring tab gating", () => {
  it("hides the Authoring tab entirely from front_desk (canAuthor false)", () => {
    render(<ScheduleScreen query={HEATMAP} canAuthor={false} overviewQuery={success(overview())} actions={fakeActions()} />);
    expect(screen.queryByRole("tab", { name: "Authoring" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    // The heatmap remains the whole screen.
    expect(screen.getByRole("heading", { name: "30-day fill heatmap" })).toBeDefined();
    expect(screen.queryByText("Author the schedule")).toBeNull();
  });

  it("shows the Authoring tab to owner/manager (canAuthor true)", () => {
    render(<ScheduleScreen query={HEATMAP} canAuthor overviewQuery={success(overview())} actions={fakeActions()} />);
    expect(screen.getByRole("tab", { name: "Authoring" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Heatmap" })).toBeDefined();
  });
});

describe("ScheduleScreen — authoring week view", () => {
  it("renders draft and published sessions distinctly with text labels, not color alone", () => {
    renderAuthoring();
    const draft = screen.getByTestId("session-status-draft");
    const published = screen.getByTestId("session-status-published");
    // Each badge carries a readable text label (never color-only).
    expect(draft.textContent).toContain("Draft");
    expect(published.textContent).toContain("Published");
    // And they are visually distinct (different tint token classes).
    expect(draft.className).not.toBe(published.className);
    expect(draft.className).toContain("bg-warning-tint");
    expect(published.className).toContain("bg-success-tint");
  });
});

describe("ScheduleScreen — create-session preview", () => {
  it("previews the resolved absolute start with an explicit timezone label", () => {
    renderAuthoring();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const preview = screen.getByTestId("session-time-preview");
    expect(preview.textContent).toContain("Resolves to");
    expect(preview.textContent).toContain(TZ);
  });
});

describe("ScheduleScreen — publish requires confirmation", () => {
  it("does not publish on render and only fires after the confirm action", () => {
    const actions = renderAuthoring();
    // No publish on render.
    expect(actions.publish.mutate).not.toHaveBeenCalled();

    // Opening the confirm dialog must not publish either.
    fireEvent.click(screen.getByRole("button", { name: "Publish 1 draft" }));
    const dialog = screen.getByRole("dialog");
    expect(actions.publish.mutate).not.toHaveBeenCalled();

    // Only the explicit confirm inside the dialog publishes.
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish 1 draft" }));
    expect(actions.publish.mutate).toHaveBeenCalledTimes(1);
    expect(actions.publish.mutate).toHaveBeenCalledWith(
      { session_ids: [DRAFT_ID] },
      expect.any(Object),
    );
  });
});
