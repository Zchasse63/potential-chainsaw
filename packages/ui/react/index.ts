/**
 * @kelo/ui/react — the surface-neutral, contract-bearing React components
 * (plan-member-app §6.4): the provenance boundary and its freshness/status
 * chips, honest empty/error/skeleton states, and the source label. Member
 * and operator surfaces share ONE implementation so the provenance contract
 * (CLAUDE.md invariant #3) renders identically everywhere.
 *
 * Dependency rule (guarded by test/react-import-guard.test.ts): react,
 * react-dom, @kelo/contracts only — never an app, never @sentry. Telemetry
 * is INJECTED (DataBoundary's onError prop), not imported.
 *
 * Extension note: sibling specifiers use `.js` (not apps/web's `.jsx`) —
 * this package is tsc-EMITTED to dist, and tsc keeps specifiers verbatim
 * while naming outputs .js; Vite/tsc resolve `.js` → `.tsx` at source level.
 */
export { DataBoundary, type BoundaryQuery, type DataBoundaryProps } from "./data-boundary.js";
export { FreshnessChip } from "./freshness-chip.js";
export { StatusPill, type StatusPillStatus } from "./status-pill.js";
export { EmptyState } from "./empty-state.js";
export { ErrorPanel } from "./error-panel.js";
export { Skeleton } from "./skeleton.js";
export { SourceLabel } from "./source-label.js";
