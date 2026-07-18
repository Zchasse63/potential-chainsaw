// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiRequestError } from "../src/lib/api.js";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import type {
  FeedbackMutationHandle,
  FocusMutationHandle,
  MutationCallbacks,
} from "../src/lib/today.js";
import { TodayScreen, type TodayScreenProps } from "../src/screens/today-screen.jsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../src/lib/telemetry.js", () => ({
  initTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const META = {
  as_of: new Date().toISOString(),
  source: "glofox",
  stale: false,
  definition_version: "v1",
  correlation_id: "corr-today-1",
};

function success(data: unknown, meta = META): BoundaryQuery {
  return { status: "success", data: { data, meta }, isRefetching: false, refetch: vi.fn() };
}

function error(errorValue: unknown): BoundaryQuery {
  return { status: "error", error: errorValue, refetch: vi.fn() };
}

const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: ARTIFACT_ID,
    generated_for: "2026-07-18",
    status: "generated",
    prompt_version: 1,
    model: "test-model",
    input: {
      selected: [
        {
          id: "payment_risk:outstanding",
          category: "payments",
          headline_facts: { failed_count: 3, failed_sum: 214, window_days: 30 },
          evidence: {
            metric_refs: ["failed_payments_outstanding"],
            segment_keys: ["payment_risk"],
          },
        },
      ],
    },
    input_hash: "hash",
    output: {
      insights: [
        {
          id: "payment_risk:outstanding",
          headline: "Review 3 failed payments",
          why: "3 payments totaling 214 need review.",
          action: "Open the payment queue",
        },
      ],
    },
    cost_usd: 0.01,
    error: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const KPIS = {
  member_count: { value: 125, definition: { key: "member_count", version: 1 } },
  mrr: {
    value: { mrr: 5000, contributing_members: 80, excluded_partner: 2 },
    definition: { key: "mrr", version: 1 },
  },
  collected_30d: {
    value: { gross: 4500, refunds: 500, net: 4000, txn_count: 91 },
    definition: { key: "collected_revenue", version: 1 },
  },
  failed_payments: {
    value: { failed_count: 3, failed_sum: 214, people: 3 },
    definition: { key: "failed_payments_outstanding", version: 1 },
  },
  credit_liability: {
    value: { outstanding_credits: 40, est_liability: 800, approximate: true },
    definition: { key: "credit_liability", version: 1 },
  },
  attendance_30d: {
    value: { attended: 90, no_show: 5, late_cancel: 5, attendance_rate: 90, no_show_rate: 5 },
    definition: { key: "attendance_rate", version: 1 },
  },
};

const DEFINITIONS = {
  definitions: Object.values(KPIS).map((metric, index) => ({
    id: `33333333-3333-4333-8333-33333333333${index}`,
    key: metric.definition.key,
    version: metric.definition.version,
    definition:
      metric.definition.key === "member_count"
        ? "Active members included by the current membership rule."
        : `Dictionary definition for ${metric.definition.key}.`,
    notes: null,
    effective_from: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:00.000Z",
  })),
};

const FOCUS_ITEM = {
  item_key: "at_risk:44444444-4444-4444-8444-444444444444",
  category: "at_risk",
  person_id: "44444444-4444-4444-8444-444444444444",
  facts: { first_name: "Ari", last_name: "Lane", days_since_attendance: 25, visit_count: 4 },
};

const HEALTH = {
  freshness: [
    {
      entity: "members",
      health_state: "healthy",
      last_success_at: new Date().toISOString(),
      minutes_stale: 2,
      bucket: "synced",
    },
  ],
};

function renderToday(overrides: Partial<TodayScreenProps> = {}) {
  const feedback: FeedbackMutationHandle = { mutate: vi.fn() };
  const focusMutation: FocusMutationHandle = { mutate: vi.fn() };
  const props: TodayScreenProps = {
    briefingQuery: success({ artifact: artifact() }, { ...META, source: "mixed" }),
    yesterdayQuery: { status: "pending", refetch: vi.fn() },
    kpiQuery: success(KPIS),
    definitionsQuery: success(DEFINITIONS),
    focusQuery: success({ items: [FOCUS_ITEM] }, { ...META, source: "mixed" }),
    healthQuery: success(HEALTH, { ...META, source: "native" }),
    feedback,
    focusMutation,
    ...overrides,
  };
  render(<TodayScreen {...props} />);
  return { feedback, focusMutation, props };
}

describe("TodayScreen — independent morning-review modules", () => {
  it("renders a refused reason and Health link while KPIs remain available", () => {
    const refused = artifact({
      status: "refused",
      error: "reconciliation drift exceeds threshold",
      output: {
        insights: [],
        message: "briefing refused because source data health is red",
        health: {
          reconciliation_ids: ["99999999-9999-4999-8999-999999999999"],
          sync_entities: [],
        },
      },
    });
    renderToday({
      briefingQuery: success({ artifact: refused }, { ...META, source: "mixed" }),
    });

    expect(screen.getByText(/Briefing paused: briefing refused/)).toBeDefined();
    expect(screen.getByText(/99999999-9999-4999-8999-999999999999/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Open Health" }).getAttribute("href")).toBe("/health");
    expect(screen.getByText("Member count")).toBeDefined();
    expect(screen.getByText("125")).toBeDefined();
    expect(screen.getByText(/Metrics-only mode/)).toBeDefined();
  });

  it("badges yesterday when today's 404 falls back to a stale artifact", () => {
    renderToday({
      briefingQuery: error(
        new ApiRequestError(404, "briefing_not_generated", "not generated", "corr-404"),
      ),
      yesterdayQuery: success({ artifact: artifact() }, { ...META, source: "mixed", stale: true }),
    });
    expect(screen.getByText("Yesterday's briefing")).toBeDefined();
    expect(screen.getByTestId("briefing-status").textContent).toContain("Yesterday");
    expect(screen.queryByText("Some data below is stale")).toBeNull();
  });

  it("states honestly when a completed briefing has no urgent actions", () => {
    renderToday({
      briefingQuery: success(
        { artifact: artifact({ output: { insights: [] } }) },
        { ...META, source: "mixed" },
      ),
    });
    expect(screen.getByText("No urgent actions today.")).toBeDefined();
  });

  it("degrades one invalid KPI tile without blanking its siblings", () => {
    renderToday({
      kpiQuery: success({ ...KPIS, mrr: { broken: true } }),
    });
    expect(screen.getByText("125")).toBeDefined();
    expect(screen.getByText("$4,000")).toBeDefined();
    expect(
      screen.getByText("MRR isn't shown. The other KPI tiles were not affected."),
    ).toBeDefined();
    expect(screen.queryByText("$5,000")).toBeNull();
  });

  it("requires a dismissal reason and keeps the row until server acknowledgement", () => {
    let callbacks: MutationCallbacks | undefined;
    const mutate = vi.fn((_input, receivedCallbacks?: MutationCallbacks) => {
      callbacks = receivedCallbacks;
    });
    renderToday({ focusMutation: { mutate } });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
    const confirm = screen.getByRole("button", { name: "Dismiss with reason" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Dismissal reason"), {
      target: { value: "Already contacted in person" },
    });
    fireEvent.click(confirm);

    expect(mutate).toHaveBeenCalledWith(
      {
        item_key: FOCUS_ITEM.item_key,
        action: "dismissed",
        reason: "Already contacted in person",
      },
      expect.any(Object),
    );
    expect(screen.getByText("Ari Lane")).toBeDefined();
    act(() => callbacks?.onSuccess?.());
    expect(screen.queryByText("Ari Lane")).toBeNull();
  });

  it("posts feedback with the artifact and item reference, then shows acknowledged state", () => {
    let callbacks: MutationCallbacks | undefined;
    const mutate = vi.fn((_input, receivedCallbacks?: MutationCallbacks) => {
      callbacks = receivedCallbacks;
    });
    renderToday({ feedback: { mutate } });

    fireEvent.click(screen.getByRole("button", { name: "Helpful: payment_risk:outstanding" }));
    expect(mutate).toHaveBeenCalledWith(
      {
        artifact_id: ARTIFACT_ID,
        item_ref: "payment_risk:outstanding",
        verdict: "up",
      },
      expect.any(Object),
    );
    expect(screen.queryByText("Feedback sent: Helpful")).toBeNull();
    act(() => callbacks?.onSuccess?.());
    expect(screen.getByText("✓ Feedback sent: Helpful")).toBeDefined();
  });

  it("shows the fetched dictionary definition with key and version in its tooltip", () => {
    renderToday();
    const trigger = screen.getByRole("button", { name: "Definition for Member count" });
    fireEvent.focus(trigger);
    const tooltipId = trigger.getAttribute("aria-describedby");
    const tooltip = tooltipId === null ? null : document.getElementById(tooltipId);
    expect(tooltip?.textContent).toContain(
      "Active members included by the current membership rule.",
    );
    expect(tooltip?.textContent).toContain("member_count · v1");
  });

  it("uses readable status text and markers, never color alone", () => {
    renderToday();
    const status = screen.getByTestId("briefing-status");
    expect(status.textContent).toContain("✓");
    expect(status.textContent).toContain("Generated");
    expect(screen.getAllByTestId("freshness-chip")[0]?.textContent).toMatch(/SYNCED|LIVE/);
  });
});
