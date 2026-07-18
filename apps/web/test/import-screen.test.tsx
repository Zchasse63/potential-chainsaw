// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { ImportReviewScreen, type ResolveMutationHandle } from "../src/screens/import-screen.jsx";
import type { ResolveQuarantineInput } from "../src/lib/import.js";

// Screens navigate with TanStack <Link>; tests stub it as a plain anchor
// rather than booting a router.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// The provenance-violation report funnels through telemetry — mock it so the
// refusal test asserts behavior, not Sentry side effects.
vi.mock("../src/lib/telemetry.js", () => ({
  initTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

const META = {
  as_of: "2026-07-17T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: null,
  correlation_id: "corr-import-1",
};

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function item(id: string, entity: string, externalRef: string, reason: string) {
  return {
    id,
    entity,
    external_ref: externalRef,
    reason,
    status: "open",
    sync_run_id: RUN_ID,
    created_at: "2026-07-17T10:00:00.000Z",
    resolved_at: null,
    resolution_note: null,
  };
}

const Q1 = item(
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01",
  "members",
  "gfx-01",
  "unknown_glofox_event",
);
const Q2 = item(
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02",
  "members",
  "gfx-02",
  "unknown_glofox_event",
);
const Q3 = item(
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03",
  "transactions",
  "gfx-03",
  "missing_namespace",
);

const QUARANTINE_ENVELOPE = {
  data: {
    causes: [
      { entity: "members", reason: "unknown_glofox_event", open_count: 2 },
      { entity: "transactions", reason: "missing_namespace", open_count: 1 },
    ],
    items: [Q1, Q2, Q3],
    next_cursor: null,
  },
  meta: META,
};

function reconciliation(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT,
    entity: "transactions",
    window_start: "2026-07-16T00:00:00.000Z",
    window_end: "2026-07-17T00:00:00.000Z",
    glofox_count: 41,
    kelo_count: 41,
    glofox_sum: 1234.5,
    kelo_sum: 1234.5,
    drift_count: 0,
    drift_sum: 0,
    status,
    detail: {},
    checked_at: "2026-07-17T11:00:00.000Z",
    created_at: "2026-07-17T11:00:00.000Z",
    ...overrides,
  };
}

const RECONCILIATIONS_ENVELOPE = {
  data: {
    reconciliations: [
      reconciliation("99999999-9999-4999-8999-999999999991", "match"),
      reconciliation("99999999-9999-4999-8999-999999999992", "drift", {
        kelo_count: 39,
        drift_count: 2,
      }),
      reconciliation("99999999-9999-4999-8999-999999999993", "error", {
        glofox_count: null,
        kelo_count: null,
        glofox_sum: null,
        kelo_sum: null,
        drift_count: null,
        drift_sum: null,
      }),
    ],
    reconciliation_pending: false,
  },
  meta: META,
};

function successQuery(data: unknown): BoundaryQuery {
  return { status: "success", data, isRefetching: false, refetch: vi.fn() };
}

function idleResolver(): ResolveMutationHandle {
  return { status: "idle", mutate: vi.fn(), reset: vi.fn() };
}

const stubDetailQuery = (): BoundaryQuery =>
  successQuery({
    data: {
      item: { ...Q1, payload: { glofox_event: "mystery", raw: [1, 2] } },
    },
    meta: META,
  });

function renderScreen(overrides: Partial<Parameters<typeof ImportReviewScreen>[0]> = {}) {
  const resolver = overrides.resolver ?? idleResolver();
  render(
    <ImportReviewScreen
      quarantineQuery={successQuery(QUARANTINE_ENVELOPE)}
      reconciliationQuery={successQuery(RECONCILIATIONS_ENVELOPE)}
      resolver={resolver}
      detailQueryFor={stubDetailQuery}
      {...overrides}
    />,
  );
  return { resolver };
}

describe("ImportReviewScreen — exceptions grouped by cause (UX §3G)", () => {
  it("renders the totals header and each cause with its open count and rows", () => {
    renderScreen();
    expect(screen.getByText("Import review")).toBeDefined();
    expect(screen.getByText(/open exceptions awaiting a decision/)).toBeDefined();
    expect(screen.getByText(/Full import totals/)).toBeDefined();
    // Grouped by cause…
    expect(screen.getByText("unknown_glofox_event")).toBeDefined();
    expect(screen.getByText("missing_namespace")).toBeDefined();
    expect(screen.getByText("2 open")).toBeDefined();
    expect(screen.getByText("1 open")).toBeDefined();
    // …with the loaded rows inside their group.
    expect(screen.getByText("gfx-01")).toBeDefined();
    expect(screen.getByText("gfx-02")).toBeDefined();
    expect(screen.getByText("gfx-03")).toBeDefined();
  });

  it("disables batch selection across causes and enables it within one", () => {
    const { resolver } = renderScreen();
    fireEvent.click(screen.getByLabelText("Select row gfx-01"));

    // Same cause stays enabled; the other cause is locked with an explanation.
    expect((screen.getByLabelText("Select row gfx-02") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Select row gfx-03") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Batch decisions stay within one cause/)).toBeDefined();

    const resolveButton = screen.getByRole("button", { name: "Resolve 1" });
    expect((resolveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(resolveButton);
    expect(resolver.mutate).toHaveBeenCalledTimes(1);
    expect(resolver.mutate).toHaveBeenCalledWith({ ids: [Q1.id], status: "resolved" });
  });

  it("requires a note before a dismiss can commit", () => {
    const { resolver } = renderScreen();
    fireEvent.click(screen.getByLabelText("Select row gfx-01"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 1" }));

    const confirm = screen.getByRole("button", { name: "Dismiss 1 with note" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(resolver.mutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Why are these being dismissed/), {
      target: { value: "Vendor confirmed these are test rows" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(resolver.mutate).toHaveBeenCalledWith({
      ids: [Q1.id],
      status: "dismissed",
      note: "Vendor confirmed these are test rows",
    } satisfies ResolveQuarantineInput);
  });

  it("clears a staged selection without committing (reversible until commit)", () => {
    const { resolver } = renderScreen();
    fireEvent.click(screen.getByLabelText("Select row gfx-01"));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("button", { name: "Resolve 1" })).toBeNull();
    // The other cause is selectable again.
    expect((screen.getByLabelText("Select row gfx-03") as HTMLInputElement).disabled).toBe(false);
    expect(resolver.mutate).not.toHaveBeenCalled();
  });

  it("shows a per-row committing state, then server-confirmed — never optimistic", () => {
    const pendingResolver: ResolveMutationHandle = {
      status: "pending",
      variables: { ids: [Q1.id], status: "resolved" },
      mutate: vi.fn(),
      reset: vi.fn(),
    };
    renderScreen({ resolver: pendingResolver });
    expect(screen.getByText("Committing…")).toBeDefined();
    expect((screen.getByLabelText("Select row gfx-01") as HTMLInputElement).disabled).toBe(true);
    cleanup();

    const successResolver: ResolveMutationHandle = {
      status: "success",
      variables: { ids: [Q1.id], status: "resolved" },
      data: { data: { items: [{ ...Q1, status: "resolved" }] }, meta: META },
      mutate: vi.fn(),
      reset: vi.fn(),
    };
    renderScreen({ resolver: successResolver });
    expect(screen.getByText(/Server confirmed — 1 row marked resolved/)).toBeDefined();
    expect(screen.getByText("Resolved — server confirmed")).toBeDefined();
  });

  it("names what did NOT happen when a commit fails", () => {
    const errorResolver: ResolveMutationHandle = {
      status: "error",
      variables: { ids: [Q1.id], status: "resolved" },
      error: new Error("boom"),
      mutate: vi.fn(),
      reset: vi.fn(),
    };
    renderScreen({ resolver: errorResolver });
    expect(screen.getByText("The server didn't confirm this decision")).toBeDefined();
    expect(screen.getByText(/rows still listed as open were NOT changed/)).toBeDefined();
  });

  it("opens the row detail drawer with the payload and reason", () => {
    renderScreen();
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0] as HTMLElement);
    expect(screen.getByRole("dialog", { name: "Quarantine row detail" })).toBeDefined();
    expect(screen.getByText(/"glofox_event": "mystery"/)).toBeDefined();
    expect(screen.getAllByText("unknown_glofox_event").length).toBeGreaterThan(0);
    expect(screen.getByText(/see recent runs on Health/)).toBeDefined();
  });
});

describe("ImportReviewScreen — honest state taxonomy", () => {
  it("empty queue is a designed state, not a blank", () => {
    renderScreen({
      quarantineQuery: successQuery({
        data: { causes: [], items: [], next_cursor: null },
        meta: META,
      }),
    });
    expect(screen.getByText("No open exceptions — the import is clean")).toBeDefined();
  });

  it("reconciliation-pending is an honest banner, NOT an error", () => {
    renderScreen({
      reconciliationQuery: successQuery({
        data: { reconciliations: [], reconciliation_pending: true },
        meta: META,
      }),
    });
    expect(screen.getByText("Reconciliation runs when the import pipeline lands")).toBeDefined();
    // Distinctly not an error panel and not the empty-table state.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No reconciliation checks yet")).toBeNull();
  });

  it("reconciliation with an existing-but-empty table says so", () => {
    renderScreen({
      reconciliationQuery: successQuery({
        data: { reconciliations: [], reconciliation_pending: false },
        meta: META,
      }),
    });
    expect(screen.getByText("No reconciliation checks yet")).toBeDefined();
  });

  it("query errors render consequence states per region", () => {
    renderScreen({
      quarantineQuery: { status: "error", error: new Error("boom"), refetch: vi.fn() },
      reconciliationQuery: { status: "error", error: new Error("boom"), refetch: vi.fn() },
    });
    expect(
      screen.getByText(
        "The import review queue didn't load — no exception was shown and no decision was taken.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "The reconciliation history didn't load — no comparison was shown and no decision was taken.",
      ),
    ).toBeDefined();
  });

  it("REFUSES a meta-less payload — provenance or nothing", () => {
    renderScreen({
      quarantineQuery: successQuery({ data: { causes: [], items: [] } }),
    });
    expect(
      screen.getByText("This data can't be shown — its provenance record is missing."),
    ).toBeDefined();
    expect(screen.queryByText("unknown_glofox_event")).toBeNull();
  });
});

describe("ImportReviewScreen — reconciliation status pills are never color-only", () => {
  it("each status gets a distinct marker glyph AND text label", () => {
    renderScreen();
    const match = screen.getByTestId("status-pill-match");
    const drift = screen.getByTestId("status-pill-drift");
    const error = screen.getByTestId("status-pill-error");

    expect(match.textContent).toContain("Match");
    expect(drift.textContent).toContain("Drift");
    expect(error.textContent).toContain("Error");

    const markers = [match, drift, error].map((pill) => pill.getAttribute("data-marker"));
    expect(markers[0]).toBe("✓");
    expect(markers[1]).toBe("▲");
    expect(markers[2]).toBe("✕");
    // Three DISTINCT shapes — the glyph carries the state, not just the hue.
    expect(new Set(markers).size).toBe(3);
    // And the marker is visible text content, not only an attribute.
    for (const pill of [match, drift, error]) {
      expect(pill.textContent?.trim().length).toBeGreaterThan("Match".length);
    }
  });

  it("labels the comparison as imported Glofox vs native Kelo", () => {
    renderScreen();
    expect(screen.getByText("Imported from Glofox")).toBeDefined();
    expect(screen.getByText(/compared against native Kelo/)).toBeDefined();
  });
});
