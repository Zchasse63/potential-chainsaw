// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiRequestError } from "@kelo/contracts";
import { DataBoundary, type BoundaryQuery } from "../react/data-boundary.jsx";

// The violation report is the contract — telemetry is INJECTED via onError
// (packages/ui imports no app's telemetry), so the test passes a spy and
// asserts against it (never a silent fallback).
const onError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

const VALID_META = {
  as_of: "2026-07-17T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: null,
  correlation_id: "corr-test-1",
};

function queryOf(
  partial: Partial<BoundaryQuery> & { status: BoundaryQuery["status"] },
): BoundaryQuery {
  return { refetch: vi.fn(), ...partial };
}

describe("DataBoundary — the provenance contract (UX plan §4)", () => {
  it("initial-loading renders the geometry-stable skeleton, not children", () => {
    const children = vi.fn(() => <div>ready content</div>);
    render(
      <DataBoundary
        name="test"
        query={queryOf({ status: "pending" })}
        skeleton={<div data-testid="skeleton">skeleton</div>}
        errorConsequence="Nothing was changed."
        onError={onError}
      >
        {children}
      </DataBoundary>,
    );
    expect(screen.getByTestId("skeleton")).toBeDefined();
    expect(screen.queryByText("ready content")).toBeNull();
    expect(children).not.toHaveBeenCalled();
  });

  it("error renders consequence + detail + retry, and retry refetches", () => {
    const refetch = vi.fn();
    render(
      <DataBoundary
        name="test"
        query={queryOf({ status: "error", error: new Error("boom"), refetch })}
        skeleton={<div />}
        errorConsequence="The report didn't load — no data was changed."
        onError={onError}
      >
        {() => <div>ready content</div>}
      </DataBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("The report didn't load — no data was changed.")).toBeDefined();
    expect(screen.getByText("boom")).toBeDefined();
    fireEvent.click(screen.getByText("Try again"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("error surfaces the API correlation id as the reference", () => {
    render(
      <DataBoundary
        name="test"
        query={queryOf({
          status: "error",
          error: new ApiRequestError(500, "internal_error", "internal server error", "corr-xyz"),
        })}
        skeleton={<div />}
        errorConsequence="No data was changed."
        onError={onError}
      >
        {() => <div>ready content</div>}
      </DataBoundary>,
    );
    expect(screen.getByText("Reference corr-xyz")).toBeDefined();
  });

  it("REFUSES to render a success payload that is missing meta — and reports it", () => {
    const children = vi.fn(() => <div>ready content</div>);
    render(
      <DataBoundary
        name="health"
        query={queryOf({ status: "success", data: { data: { freshness: [] } } })}
        skeleton={<div />}
        errorConsequence="No data was changed."
        onError={onError}
      >
        {children}
      </DataBoundary>,
    );
    // Visibly refused…
    expect(screen.getByRole("alert")).toBeDefined();
    expect(
      screen.getByText("This data can't be shown — its provenance record is missing."),
    ).toBeDefined();
    // …children NEVER rendered (no silent fallback)…
    expect(children).not.toHaveBeenCalled();
    expect(screen.queryByText("ready content")).toBeNull();
    // …and the violation is a monitored error, not a console shrug.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("also refuses when meta is present but fails the envelope schema", () => {
    const children = vi.fn(() => <div>ready content</div>);
    render(
      <DataBoundary
        name="health"
        query={queryOf({
          status: "success",
          data: { data: {}, meta: { as_of: "2026-07-17T12:00:00.000Z", source: "native" } },
        })}
        skeleton={<div />}
        errorConsequence="No data was changed."
        onError={onError}
      >
        {children}
      </DataBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(children).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ready renders children with data + meta when the envelope is valid", () => {
    const children = vi.fn((data: { value: number }) => <div>value is {data.value}</div>);
    render(
      <DataBoundary
        name="test"
        query={queryOf({ status: "success", data: { data: { value: 42 }, meta: VALID_META } })}
        skeleton={<div />}
        errorConsequence="No data was changed."
        onError={onError}
      >
        {children}
      </DataBoundary>,
    );
    expect(screen.getByText("value is 42")).toBeDefined();
    expect(children).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stale is a labeled flag composed on top of ready, not a replacement state", () => {
    render(
      <DataBoundary
        name="test"
        query={queryOf({
          status: "success",
          data: { data: { value: 1 }, meta: { ...VALID_META, stale: true } },
        })}
        skeleton={<div />}
        errorConsequence="No data was changed."
        onError={onError}
      >
        {() => <div>ready content</div>}
      </DataBoundary>,
    );
    expect(screen.getByText("Some data below is stale")).toBeDefined();
    expect(screen.getByText("ready content")).toBeDefined();
  });

  it("defaults to a no-op onError when the app does not inject telemetry", () => {
    // No onError prop — the refusal still renders and nothing throws.
    render(
      <DataBoundary
        name="health"
        query={queryOf({ status: "success", data: { data: {} } })}
        skeleton={<div />}
        errorConsequence="No data was changed."
      >
        {() => <div>ready content</div>}
      </DataBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.queryByText("ready content")).toBeNull();
  });
});
