import type { Reconciliation } from "../lib/import.js";
import { formatTimestamp } from "../lib/time.js";
import { EmptyState } from "./empty-state.jsx";
import { SourceLabel } from "./source-label.jsx";
import { StatusPill } from "./status-pill.jsx";

/**
 * Reconciliation rendering, shared by the Health screen and Import review
 * (UX plan §3F). The numbers compare IMPORTED GLOFOX against NATIVE KELO and
 * are labeled as such — drift is Kelo-vs-Glofox, never an unexplained delta.
 */

/** The honest pending state: the unit-1.5 table doesn't exist yet. NOT an error. */
export function ReconciliationPendingNotice() {
  return (
    <div role="status" className="rounded-2 border border-info-border bg-info-tint px-4 py-3">
      <p className="text-body font-medium text-info-on-tint">
        Reconciliation runs when the import pipeline lands
      </p>
      <p className="mt-1 text-body text-info-on-tint">
        This is a pending pipeline, not a failure — no comparison has run and none is overdue. The
        moment the sync worker&apos;s reconciliation table exists, recent checks appear here.
      </p>
    </div>
  );
}

function sum(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function count(value: number | null): string {
  return value === null ? "—" : String(value);
}

function windowLabel(row: Reconciliation): string {
  if (row.window_start === null && row.window_end === null) {
    return "—";
  }
  const start = row.window_start === null ? "…" : formatTimestamp(row.window_start);
  const end = row.window_end === null ? "…" : formatTimestamp(row.window_end);
  return `${start} – ${end}`;
}

export function ReconciliationTable({ rows }: { rows: Reconciliation[] }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SourceLabel source="glofox" />
        <span className="text-chrome text-ink-muted">compared against native Kelo</span>
        <SourceLabel source="native" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-table">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
                Entity
              </th>
              <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
                Window
              </th>
              <th className="py-2 pr-4 text-right font-mono text-micro uppercase tracking-wide text-ink-muted">
                Glofox rows
              </th>
              <th className="py-2 pr-4 text-right font-mono text-micro uppercase tracking-wide text-ink-muted">
                Kelo rows
              </th>
              <th className="py-2 pr-4 text-right font-mono text-micro uppercase tracking-wide text-ink-muted">
                Drift rows
              </th>
              <th className="py-2 pr-4 text-right font-mono text-micro uppercase tracking-wide text-ink-muted">
                Glofox sum
              </th>
              <th className="py-2 pr-4 text-right font-mono text-micro uppercase tracking-wide text-ink-muted">
                Kelo sum
              </th>
              <th className="py-2 pr-4 font-mono text-micro uppercase tracking-wide text-ink-muted">
                Status
              </th>
              <th className="py-2 font-mono text-micro uppercase tracking-wide text-ink-muted">
                Checked
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const drifted = row.drift_count !== null && row.drift_count !== 0;
              return (
                <tr key={row.id} className="border-b border-hairline">
                  <td className="py-2 pr-4 text-ink">{row.entity}</td>
                  <td className="py-2 pr-4 font-mono text-ink-secondary">{windowLabel(row)}</td>
                  <td className="py-2 pr-4 text-right font-mono text-ink-secondary">
                    {count(row.glofox_count)}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono text-ink-secondary">
                    {count(row.kelo_count)}
                  </td>
                  <td
                    className={`py-2 pr-4 text-right font-mono ${
                      drifted ? "font-semibold text-warning-emphasis" : "text-ink-secondary"
                    }`}
                  >
                    {count(row.drift_count)}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono text-ink-secondary">
                    {sum(row.glofox_sum)}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono text-ink-secondary">
                    {sum(row.kelo_sum)}
                  </td>
                  <td className="py-2 pr-4">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="py-2 font-mono text-ink-secondary">
                    {formatTimestamp(row.checked_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The full region state taxonomy for a reconciliation list payload. */
export function ReconciliationRegion({
  pending,
  rows,
}: {
  pending: boolean;
  rows: Reconciliation[];
}) {
  if (pending) {
    return <ReconciliationPendingNotice />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No reconciliation checks yet"
        body="The reconciliation table exists but no check has run — checks run after each import window and land here with their Glofox-vs-Kelo counts."
      />
    );
  }
  return <ReconciliationTable rows={rows} />;
}
