import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvelopeMeta } from "@kelo/contracts";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "@kelo/ui/react";
import { FreshnessChip } from "@kelo/ui/react";
import { ReconciliationRegion } from "../components/reconciliation.jsx";
import { Skeleton } from "@kelo/ui/react";
import { SourceLabel } from "@kelo/ui/react";
import type {
  AlertSeverity,
  AuthorityRow,
  EntityFreshness,
  HealthQuarantineSummary,
  HealthReconciliation,
  HealthReport,
  OpenAlert,
  SyncRun,
} from "../lib/health.js";
import { deviceTimeZone, formatTimestamp } from "../lib/time.js";

/**
 * Health v0 — the trust surface (UX plan §3F). Phase 0 has no import pipeline
 * and no verification ledger, so the screen's job is HONESTY: the trust
 * streak is an em-dash with an explanation, empty lists say their emptiness
 * is expected, and every region renders through DataBoundary.
 */

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3 border border-hairline bg-surface-card">
      <header className="border-b border-hairline px-4 py-3">
        <h2 className="font-mono text-micro uppercase tracking-wide text-ink-muted">{title}</h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function PageHeader({ meta }: { meta: EnvelopeMeta }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-title font-bold tracking-tight">Health</h1>
        <SourceLabel source={meta.source === "native" ? "native" : "glofox"} />
      </div>
      <p className="mt-1 text-chrome text-ink-muted">
        Report generated {formatTimestamp(meta.as_of)} · Times shown in {deviceTimeZone()} (this
        device&apos;s timezone)
      </p>
    </div>
  );
}

function TrustStreak() {
  return (
    <section
      aria-labelledby="trust-streak-title"
      className="rounded-3 border border-hairline bg-surface-card p-6"
    >
      <h2
        id="trust-streak-title"
        className="font-mono text-micro uppercase tracking-wide text-ink-muted"
      >
        Days since an unchecked figure
      </h2>
      <p className="mt-2 font-display text-hero font-bold">—</p>
      <p className="mt-1 text-body text-ink-muted">
        Tracking begins with imports — the verification ledger that backs this number ships with the
        import pipeline (phase 1). Until it exists, there is nothing honest to count, so this screen
        shows no number.
      </p>
    </section>
  );
}

function FreshnessList({ items }: { items: EntityFreshness[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No sync entities yet"
        body="This is expected, not a failure — the import pipeline lands in phase 1, and each entity will appear here with its own freshness chip once it starts reporting."
      />
    );
  }
  return (
    <ul className="divide-y divide-hairline">
      {items.map((item) => (
        <li key={item.entity} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
          <span className="w-32 text-body font-medium text-ink">{item.entity}</span>
          <FreshnessChip bucket={item.bucket} minutesStale={item.minutes_stale} />
          <span className="font-mono text-chrome text-ink-muted">{item.health_state}</span>
          <span className="ml-auto font-mono text-chrome text-ink-secondary">
            {item.last_success_at === null
              ? "Never synced"
              : `Last success ${formatTimestamp(item.last_success_at)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function runStatusLabel(status: SyncRun["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "error":
      return "Error";
    case "empty_suspect":
      return "Empty (suspect)";
    case null:
      return "—";
  }
}

function RunsTable({ runs }: { runs: SyncRun[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No imports yet — the import pipeline lands in phase 1"
        body="Empty is the expected state here: no sync has ever run on this tenant, so there is nothing to show and nothing is wrong."
      />
    );
  }
  return (
    <table className="w-full border-collapse text-table">
      <thead>
        <tr className="border-b border-hairline text-left">
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Entity
          </th>
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Status
          </th>
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Started
          </th>
          <th className="py-2 text-right font-mono text-micro uppercase tracking-wide text-ink-muted">
            Rows
          </th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-b border-hairline">
            <td className="py-2 pr-4 text-ink">{run.entity}</td>
            <td
              className={`py-2 pr-4 ${run.status === "error" ? "text-danger" : "text-ink-secondary"}`}
            >
              {runStatusLabel(run.status)}
            </td>
            <td className="py-2 pr-4 font-mono text-ink-secondary">
              {formatTimestamp(run.started_at)}
            </td>
            <td className="py-2 text-right font-mono text-ink-secondary">
              {run.rows_upserted ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SEVERITY_PILL: Record<AlertSeverity, { marker: string; classes: string; label: string }> = {
  // Shape + icon + color, never color alone (design guide §4 grammar).
  critical: {
    marker: "■",
    classes: "border-danger-border bg-danger-tint text-danger-on-tint",
    label: "Critical",
  },
  warning: {
    marker: "▲",
    classes: "border-warning-border bg-warning-tint text-warning-on-tint",
    label: "Warning",
  },
  info: {
    marker: "●",
    classes: "border-info-border bg-info-tint text-info-on-tint",
    label: "Info",
  },
};

function SeverityPill({ severity }: { severity: AlertSeverity }) {
  const pill = SEVERITY_PILL[severity];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${pill.classes}`}
    >
      <span aria-hidden="true">{pill.marker}</span>
      {pill.label}
    </span>
  );
}

function AlertsList({ alerts }: { alerts: OpenAlert[] }) {
  if (alerts.length === 0) {
    return (
      <EmptyState
        title="No open alerts."
        body="When an import or an automated check fails, it lands here with its operational consequence."
      />
    );
  }
  return (
    <ul className="space-y-3">
      {alerts.map((alert) => (
        <li key={alert.id} className="rounded-2 border border-hairline px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityPill severity={alert.severity} />
            <span className="text-body font-medium text-ink">{alert.title}</span>
            <span className="ml-auto font-mono text-chrome text-ink-muted">
              {formatTimestamp(alert.created_at)}
            </span>
          </div>
          {alert.body !== null && <p className="mt-1 text-body text-ink-secondary">{alert.body}</p>}
        </li>
      ))}
    </ul>
  );
}

function AuthorityTable({ rows }: { rows: AuthorityRow[] }) {
  return (
    <table className="w-full border-collapse text-table">
      <thead>
        <tr className="border-b border-hairline text-left">
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Capability
          </th>
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Read source
          </th>
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Write source
          </th>
          <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
            State
          </th>
          <th className="py-2 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Cutover
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.capability} className="border-b border-hairline">
            <td className="py-2 pr-4 font-medium text-ink">{row.capability}</td>
            <td className="py-2 pr-4 text-ink-secondary">Glofox</td>
            <td className="py-2 pr-4 text-ink-secondary">Glofox</td>
            <td className="py-2 pr-4 text-ink-secondary">Glofox authoritative</td>
            <td className="py-2 text-ink-secondary">
              Glofox authoritative — no cutover scheduled
              <span className="block font-mono text-chrome text-ink-muted">
                Imports {row.cadence}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HealthSkeleton() {
  return (
    <div role="status" aria-label="Loading health data" className="space-y-6">
      <span className="sr-only">Loading health data…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-36 w-full rounded-3" />
      <Skeleton className="h-64 w-full rounded-3" />
      <Skeleton className="h-44 w-full rounded-3" />
      <Skeleton className="h-28 w-full rounded-3" />
      <Skeleton className="h-40 w-full rounded-3" />
      <Skeleton className="h-32 w-full rounded-3" />
      <Skeleton className="h-48 w-full rounded-3" />
    </div>
  );
}

/**
 * Quarantine summary (UX plan §3F): open count + top causes, with the full
 * review one tap away at /import. Zero open exceptions is the clean state,
 * not a missing one.
 */
function QuarantineSummary({ summary }: { summary: HealthQuarantineSummary }) {
  if (summary.open_count === 0) {
    return (
      <EmptyState
        title="No open exceptions — the import is clean"
        body="Nothing is waiting for review. When an imported row fails validation it is held here with its reason, never silently dropped."
        action={
          <Link to="/import" className="font-medium text-link underline">
            Open import review
          </Link>
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-display text-title font-bold tracking-tight">
          {summary.open_count}
        </span>
        <span className="text-body text-ink-secondary">
          open {summary.open_count === 1 ? "exception" : "exceptions"} awaiting a decision — the
          import pauses nothing, but these rows are held out of the data until reviewed.
        </span>
      </div>
      <ul className="divide-y divide-hairline">
        {summary.by_cause.slice(0, 3).map((cause) => (
          <li
            key={`${cause.entity} ${cause.reason}`}
            className="flex flex-wrap items-center gap-x-3 py-2"
          >
            <span className="font-mono text-micro uppercase tracking-wide text-ink-muted">
              {cause.entity}
            </span>
            <span className="text-body text-ink">{cause.reason}</span>
            <span className="ml-auto font-mono text-chrome text-ink-secondary">
              {cause.open_count} open
            </span>
          </li>
        ))}
      </ul>
      <Link to="/import" className="inline-block font-medium text-link underline">
        Review {summary.open_count} open {summary.open_count === 1 ? "exception" : "exceptions"}
      </Link>
    </div>
  );
}

/** Reconciliation history (§3F) — the recent Kelo-vs-Glofox checks. */
function ReconciliationSection({ reconciliation }: { reconciliation: HealthReconciliation }) {
  return <ReconciliationRegion pending={reconciliation.pending} rows={reconciliation.recent} />;
}

/**
 * Pure screen component — the query result is injected so tests can mock the
 * query layer without a live API (the route wires the real one).
 */
export function HealthScreen({ query }: { query: BoundaryQuery }) {
  return (
    <DataBoundary<HealthReport>
      name="health"
      query={query}
      skeleton={<HealthSkeleton />}
      errorConsequence="The health report didn't load — nothing on this page was read from stale cache, and no data was changed."
    >
      {(report, meta) => (
        <div className="space-y-6">
          <PageHeader meta={meta} />
          <TrustStreak />
          <Card title="Entity freshness">
            <FreshnessList items={report.freshness} />
          </Card>
          <Card title="Recent import runs">
            <RunsTable runs={report.sync_runs} />
          </Card>
          <Card title="Quarantine">
            <QuarantineSummary summary={report.quarantine} />
          </Card>
          <Card title="Reconciliation">
            <ReconciliationSection reconciliation={report.reconciliation} />
          </Card>
          <Card title="Open alerts">
            <AlertsList alerts={report.alerts} />
          </Card>
          <Card title="Authority matrix">
            <AuthorityTable rows={report.authority} />
          </Card>
        </div>
      )}
    </DataBoundary>
  );
}
