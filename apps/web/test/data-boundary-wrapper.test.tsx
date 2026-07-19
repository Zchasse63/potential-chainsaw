// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// apps/web wraps the shared @kelo/ui/react DataBoundary to inject its
// Sentry-backed telemetry as the onError funnel (Wave 8.1b). The shared
// component's funnel logic is tested in packages/ui; THIS test pins the
// apps/web-specific wiring — a provenance violation must reach reportError —
// so a future refactor cannot silently drop telemetry on the operator app.
vi.mock("../src/lib/telemetry.js", () => ({
  reportError: vi.fn(),
}));

import { DataBoundary } from "../src/components/data-boundary.jsx";
import { reportError } from "../src/lib/telemetry.js";

afterEach(cleanup);

describe("apps/web DataBoundary wrapper — telemetry injection", () => {
  it("routes a provenance violation to the app's reportError", () => {
    const children = vi.fn(() => <div>ready content</div>);
    render(
      <DataBoundary
        name="health"
        // success payload MISSING the freshness envelope meta → a provenance
        // violation the boundary must refuse to render and must report.
        query={{ status: "success", data: { data: { freshness: [] } }, refetch: vi.fn() }}
        skeleton={<div />}
        errorConsequence="No data was changed."
      >
        {children}
      </DataBoundary>,
    );

    // Refused visibly, children never rendered…
    expect(screen.getByRole("alert")).toBeDefined();
    expect(children).not.toHaveBeenCalled();
    // …and the violation reached the app's telemetry (the wired funnel).
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
