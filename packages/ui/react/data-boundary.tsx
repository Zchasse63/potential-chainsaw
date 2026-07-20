import { useEffect, useState, type ReactNode } from "react";
import { ApiRequestError, inspectEnvelope, type EnvelopeMeta } from "@kelo/contracts";
import { EmptyState } from "./empty-state.js";
import { ErrorPanel } from "./error-panel.js";

/**
 * DataBoundary — THE provenance contract (UX plan §4; CLAUDE.md invariant #3;
 * design amendment: the taxonomy is COMPOSITIONAL, not mutually exclusive).
 *
 * Primary render state: initial-loading (geometry-stable skeleton) / error /
 * empty / ready. Independent flags composed on top of ready: stale (from
 * meta.stale), offline (connectivity), updating (background refetch).
 *
 * Provenance-or-nothing: a "success" payload missing a schema-valid meta is
 * a DEFECT — the boundary visibly REFUSES to render the data and reports it
 * through the injected `onError` funnel (apps/web wires its Sentry telemetry
 * there). There is no silent fallback anywhere in this file.
 */

/** Structural minimum of TanStack Query's UseQueryResult that we consume. */
export interface BoundaryQuery {
  status: "pending" | "error" | "success";
  data?: unknown;
  error?: unknown;
  isRefetching?: boolean;
  refetch: () => unknown;
}

export interface DataBoundaryProps<T> {
  /** Name used in violation reports (which boundary refused). */
  name: string;
  query: BoundaryQuery;
  /** Geometry-stable loading UI matching the final layout. */
  skeleton: ReactNode;
  /** What did NOT happen because of the error (design guide §6 phrasing). */
  errorConsequence: string;
  /** Optional empty taxonomy: isEmpty decides, emptyState explains whether
      the emptiness is real or a sync gap. */
  isEmpty?: (data: T) => boolean;
  emptyState?: ReactNode;
  /** Optional domain-specific stale treatment. `null` is allowed when the
      ready child already renders the stale state (for example, a prominent
      yesterday-artifact badge). */
  staleState?: ReactNode;
  /** Violation funnel — each app injects its own telemetry (apps/web passes
      its Sentry-backed reportError). Defaults to a no-op. */
  onError?: (error: unknown, context?: Record<string, unknown>) => void;
  children: (data: T, meta: EnvelopeMeta) => ReactNode;
}

/** Connectivity flag — independent of the query's primary state.
 *
 * SSR-safe: on the server there is no `navigator`/`window` (Node 20 has no
 * global `navigator` at all — reading it throws; Node ≥21 exposes it but
 * `navigator.onLine` is `undefined`). A server render is definitionally
 * "online" — it just fetched the data — so it must initialise to `true` and
 * never touch `window`. This component is shared with SSR consumers
 * (apps/member is the first): a naive `navigator.onLine` initializer either
 * 500s the whole SSR handler or paints a false "you're offline" banner into
 * public HTML, then mismatches on hydration. The client corrects the flag on
 * the first `online`/`offline` event after mount.
 *
 * The `typeof` checks are evaluated at CALL time (not captured in a
 * module-level const): the DOM globals must be probed when the hook runs, so
 * the guard holds no matter when the module was loaded relative to the SSR
 * runtime. */
function browserOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(browserOnline);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

function errorDetail(error: unknown): {
  detail: string | undefined;
  correlationId: string | undefined;
} {
  if (error instanceof ApiRequestError) {
    return { detail: error.message, correlationId: error.correlationId };
  }
  if (error instanceof Error) {
    return { detail: error.message, correlationId: undefined };
  }
  return { detail: undefined, correlationId: undefined };
}

// Stable no-op so the default never churns the violation effect's deps.
const noopOnError: (error: unknown, context?: Record<string, unknown>) => void = () => {};

export function DataBoundary<T>({
  name,
  query,
  skeleton,
  errorConsequence,
  isEmpty,
  emptyState,
  staleState,
  onError = noopOnError,
  children,
}: DataBoundaryProps<T>) {
  const online = useOnlineStatus();

  const inspection = query.status === "success" ? inspectEnvelope<T>(query.data) : null;

  // Provenance violation: a successful response WITHOUT valid meta. Report
  // once per offending payload, then refuse the render below.
  const violated = inspection !== null && !inspection.ok;
  useEffect(() => {
    if (violated) {
      onError(new Error(`DataBoundary(${name}): API payload missing provenance meta`), {
        boundary: name,
        payload: query.data,
      });
    }
  }, [violated, name, query.data, onError]);

  // Primary state 1 — initial loading: geometry-stable skeleton.
  if (query.status === "pending") {
    return <>{skeleton}</>;
  }

  // Primary state 2 — error: consequence + retry + reference id.
  if (query.status === "error") {
    const { detail, correlationId } = errorDetail(query.error);
    return (
      <ErrorPanel
        title="This data didn't load"
        consequence={errorConsequence}
        detail={detail}
        correlationId={correlationId}
        onRetry={() => void query.refetch()}
      />
    );
  }

  // Provenance refusal — the payload claims success but cannot say where its
  // data came from or how old it is. Never rendered, never silent.
  if (inspection === null || !inspection.ok) {
    return (
      <div role="alert" className="rounded-3 border border-danger-border bg-danger-tint p-4">
        <p className="text-body font-medium text-danger-on-tint">
          This data can&apos;t be shown — its provenance record is missing.
        </p>
        <p className="mt-1 text-body text-danger-on-tint">
          Kelo never displays figures without their source and age. Nothing was rendered from this
          response. The defect has been reported to engineering.
        </p>
      </div>
    );
  }

  const { data, meta } = inspection;

  // Primary state 3 — empty (the caller decides what "empty" means and the
  // empty state says whether it's real or a sync gap).
  if (isEmpty !== undefined && emptyState !== undefined && isEmpty(data)) {
    return <>{emptyState}</>;
  }

  // Primary state 4 — ready, with independent flags composed on top.
  return (
    <div className="space-y-4">
      {!online && (
        <div role="status" className="rounded-2 border border-info-border bg-info-tint px-4 py-2">
          <p className="text-body text-info-on-tint">
            You&apos;re offline — this is the last data the device loaded. Actions that need the
            network are unavailable.
          </p>
        </div>
      )}
      {meta.stale &&
        (staleState !== undefined ? (
          staleState
        ) : (
          <div
            role="status"
            className="rounded-2 border border-warning-border bg-warning-tint px-4 py-2"
          >
            <p className="text-body font-medium text-warning-emphasis">Some data below is stale</p>
            <p className="text-body text-warning-on-tint">
              At least one source is 4+ hours behind. Freshness chips mark each source — treat
              red-flagged figures as unreliable for decisions.
            </p>
          </div>
        ))}
      {query.isRefetching === true && (
        <p role="status" className="text-chrome text-ink-muted">
          Updating…
        </p>
      )}
      {children(data, meta)}
    </div>
  );
}

/** Re-exported so composed regions can share one empty-state component. */
export { EmptyState };
