import { DataBoundary as SharedDataBoundary, EmptyState } from "@kelo/ui/react";
import type { DataBoundaryProps } from "@kelo/ui/react";
import { reportError } from "../lib/telemetry.js";

/**
 * apps/web's DataBoundary (Wave 8.1b): the provenance contract itself lives
 * in @kelo/ui/react, shared with every surface. This wrapper injects the
 * app's Sentry-backed telemetry as the onError funnel so a provenance
 * violation is still a monitored error (UX plan §4), and keeps the module's
 * public surface (DataBoundary + BoundaryQuery + the EmptyState re-export)
 * so existing import sites are untouched.
 */
export function DataBoundary<T>(props: DataBoundaryProps<T>) {
  return <SharedDataBoundary<T> {...props} onError={reportError} />;
}

export type { BoundaryQuery, DataBoundaryProps } from "@kelo/ui/react";

/** Re-exported so composed regions can share one empty-state component. */
export { EmptyState };
