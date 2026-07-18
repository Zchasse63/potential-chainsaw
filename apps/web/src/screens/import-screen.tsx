import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvelopeMeta } from "@kelo/contracts";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { ReconciliationRegion } from "../components/reconciliation.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { SourceLabel } from "../components/source-label.jsx";
import { ApiRequestError } from "../lib/api.js";
import type {
  QuarantineCause,
  QuarantineDetail,
  QuarantineItem,
  QuarantineListData,
  ReconciliationsData,
  ResolveQuarantineInput,
} from "../lib/import.js";
import { deviceTimeZone, formatTimestamp } from "../lib/time.js";

/**
 * Import review (UX plan §3G) — the operator's window into import
 * correctness. Exceptions are grouped by cause; batch decisions happen
 * WITHIN one cause group at a time (cross-cause batching is disabled); the
 * staged selection is reversible until the POST commits; and nothing is
 * optimistic — a row flips to resolved only after the server confirms, then
 * the queue re-reads the durable state.
 */

/** Structural minimum of the TanStack useMutation result this screen consumes. */
export interface ResolveMutationHandle {
  status: "idle" | "pending" | "error" | "success";
  variables?: ResolveQuarantineInput;
  error?: unknown;
  data?: unknown;
  mutate: (input: ResolveQuarantineInput) => void;
  reset: () => void;
}

export interface ImportReviewScreenProps {
  /** GET /import/quarantine — grouped causes + first page of open rows. */
  quarantineQuery: BoundaryQuery;
  /** GET /import/reconciliations. */
  reconciliationQuery: BoundaryQuery;
  /** The batch-decision commit (POST /import/quarantine/resolve). */
  resolver: ResolveMutationHandle;
  /** Detail fetch for the row drawer, injected hook-style so tests can stub it. */
  detailQueryFor: (id: string | null) => BoundaryQuery;
}

function causeKey(cause: Pick<QuarantineCause, "entity" | "reason">): string {
  return `${cause.entity} ${cause.reason}`;
}

/** DOM-id-safe form of a cause key (raw keys contain spaces). */
function causeDomId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

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
        <h1 className="font-display text-title font-bold tracking-tight">Import review</h1>
        <SourceLabel source={meta.source === "native" ? "native" : "glofox"} />
      </div>
      <p className="mt-1 text-chrome text-ink-muted">
        Queue loaded {formatTimestamp(meta.as_of)} · Times shown in {deviceTimeZone()} (this
        device&apos;s timezone)
      </p>
    </div>
  );
}

function TotalsHeader({ data }: { data: QuarantineListData }) {
  const openCount = data.causes.reduce((total, cause) => total + cause.open_count, 0);
  return (
    <section className="rounded-3 border border-hairline bg-surface-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-display text-title font-bold tracking-tight">{openCount}</span>
        <span className="text-body text-ink-secondary">
          open {openCount === 1 ? "exception" : "exceptions"} awaiting a decision
        </span>
      </div>
      <p className="mt-1 text-chrome text-ink-muted">
        Full import totals (imported / merged / quarantined per run) arrive with the sync runs — the
        Health page carries run history. This queue lists every open exception by cause.
      </p>
    </section>
  );
}

/** The commit outcome — persistent inline (failures never ride a toast). */
function ResultRegion({ resolver }: { resolver: ResolveMutationHandle }) {
  if (resolver.status === "pending") {
    const count = resolver.variables?.ids.length ?? 0;
    return (
      <div role="status" className="rounded-2 border border-info-border bg-info-tint px-4 py-3">
        <p className="text-body text-info-on-tint">
          Committing {count} {count === 1 ? "row" : "rows"} to the server…
        </p>
      </div>
    );
  }
  if (resolver.status === "error") {
    const detail =
      resolver.error instanceof ApiRequestError || resolver.error instanceof Error
        ? resolver.error.message
        : undefined;
    return (
      <div role="alert" className="rounded-2 border border-danger-border bg-danger-tint px-4 py-3">
        <p className="text-body font-medium text-danger-on-tint">
          The server didn&apos;t confirm this decision
        </p>
        <p className="mt-1 text-body text-danger-on-tint">
          The queue was re-read — rows still listed as open were NOT changed. Your selection is
          intact; try again or clear it.
        </p>
        {detail !== undefined && <p className="mt-1 text-chrome text-danger-on-tint">{detail}</p>}
      </div>
    );
  }
  if (resolver.status === "success") {
    const items = (resolver.data as { data?: { items?: unknown[] } } | undefined)?.data?.items;
    const count = Array.isArray(items) ? items.length : null;
    const action = resolver.variables?.status === "dismissed" ? "dismissed" : "resolved";
    return (
      <div
        role="status"
        className="rounded-2 border border-success-border bg-success-tint px-4 py-3"
      >
        <p className="text-body text-success-on-tint">
          Server confirmed — {count ?? "the"} {count === 1 ? "row" : "rows"} marked {action}. The
          queue re-read the durable state; decided rows no longer appear as open.
        </p>
      </div>
    );
  }
  return null;
}

interface Selection {
  key: string;
  ids: string[];
}

interface CauseGroupProps {
  cause: QuarantineCause;
  rows: QuarantineItem[];
  selection: Selection | null;
  activeLabel: string | null;
  pendingIds: readonly string[];
  confirmed: { ids: readonly string[]; status: "resolved" | "dismissed" } | null;
  committing: boolean;
  dismissArmed: boolean;
  dismissNote: string;
  onToggle: (key: string, id: string) => void;
  onClearSelection: () => void;
  onResolve: () => void;
  onArmDismiss: () => void;
  onCancelDismiss: () => void;
  onDismissNote: (note: string) => void;
  onConfirmDismiss: () => void;
  onOpenDetail: (id: string) => void;
}

function CauseGroup({
  cause,
  rows,
  selection,
  activeLabel,
  pendingIds,
  confirmed,
  committing,
  dismissArmed,
  dismissNote,
  onToggle,
  onClearSelection,
  onResolve,
  onArmDismiss,
  onCancelDismiss,
  onDismissNote,
  onConfirmDismiss,
  onOpenDetail,
}: CauseGroupProps) {
  const [expanded, setExpanded] = useState(true);
  const key = causeKey(cause);
  const isActive = selection !== null && selection.key === key;
  const isLocked = selection !== null && !isActive;
  const selectedCount = isActive ? selection.ids.length : 0;

  return (
    <section className="rounded-3 border border-hairline bg-surface-card">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left"
      >
        <span aria-hidden="true" className="text-ink-muted">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          {cause.entity}
        </span>
        <span className="text-body font-medium text-ink">{cause.reason}</span>
        <span className="ml-auto rounded-full border border-hairline px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-ink-secondary">
          {cause.open_count} open
        </span>
      </button>
      {expanded && (
        <div className="border-t border-hairline px-4 py-3">
          {isLocked && (
            <p className="mb-3 text-chrome text-ink-muted">
              Batch decisions stay within one cause — finish or clear the selection in “
              {activeLabel}” to work this group.
            </p>
          )}
          {rows.length === 0 ? (
            <p className="text-body text-ink-muted">
              This cause&apos;s open rows aren&apos;t on the loaded page — they page in as earlier
              rows are decided.
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {rows.map((row) => {
                const selected = isActive && selection.ids.includes(row.id);
                const isPending = pendingIds.includes(row.id);
                const confirmedStatus = confirmed?.ids.includes(row.id) ? confirmed.status : null;
                const label = row.external_ref ?? row.id;
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${label}`}
                      checked={selected}
                      disabled={isLocked || isPending || committing}
                      onChange={() => onToggle(key, row.id)}
                      className="h-5 w-5 accent-brand-600"
                    />
                    <span className="font-mono text-body text-ink">{label}</span>
                    <span className="font-mono text-chrome text-ink-muted">
                      {formatTimestamp(row.created_at)}
                    </span>
                    <span className="ml-auto flex items-center gap-3">
                      {isPending && (
                        <span role="status" className="text-chrome text-ink-muted">
                          Committing…
                        </span>
                      )}
                      {!isPending && confirmedStatus !== null && (
                        <span role="status" className="text-chrome text-ink-secondary">
                          {confirmedStatus === "dismissed" ? "Dismissed" : "Resolved"} — server
                          confirmed
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        className="h-9 px-2 text-chrome"
                        onClick={() => onOpenDetail(row.id)}
                      >
                        Details
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {isActive && selectedCount > 0 && (
            <div className="mt-3 border-t border-hairline pt-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body text-ink-secondary">
                  {selectedCount} selected in this cause
                </span>
                <Button onClick={onResolve} disabled={committing}>
                  Resolve {selectedCount}
                </Button>
                <Button variant="secondary" onClick={onArmDismiss} disabled={committing}>
                  Dismiss {selectedCount}
                </Button>
                <Button variant="ghost" onClick={onClearSelection} disabled={committing}>
                  Clear selection
                </Button>
              </div>
              {dismissArmed && (
                <div className="mt-3 space-y-2">
                  <label
                    htmlFor={`dismiss-note-${causeDomId(key)}`}
                    className="block text-body text-ink-secondary"
                  >
                    Why are these being dismissed? (required — it becomes the audit trail)
                  </label>
                  <textarea
                    id={`dismiss-note-${causeDomId(key)}`}
                    rows={2}
                    value={dismissNote}
                    onChange={(event) => onDismissNote(event.target.value)}
                    className="w-full rounded-2 border border-input-border bg-surface-input px-3 py-2 text-body text-ink"
                  />
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="secondary"
                      onClick={onConfirmDismiss}
                      disabled={dismissNote.trim() === "" || committing}
                    >
                      Dismiss {selectedCount} with note
                    </Button>
                    <Button variant="ghost" onClick={onCancelDismiss} disabled={committing}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DetailDrawer({
  id,
  onClose,
  detailQueryFor,
}: {
  id: string;
  onClose: () => void;
  detailQueryFor: (id: string | null) => BoundaryQuery;
}) {
  const query = detailQueryFor(id);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-label="Quarantine row detail"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-hairline bg-surface-card shadow-3"
    >
      <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <h2 className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          What came in
        </h2>
        <Button variant="ghost" className="h-9 px-2 text-chrome" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <DataBoundary<{ item: QuarantineDetail }>
          name="import-quarantine-detail"
          query={query}
          skeleton={
            <div role="status" aria-label="Loading row detail" className="space-y-3">
              <span className="sr-only">Loading row detail…</span>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-48 w-full rounded-3" />
            </div>
          }
          errorConsequence="The row detail didn't load — no payload was shown and no decision was taken."
        >
          {({ item }) => (
            <div className="space-y-4">
              <dl className="space-y-2">
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-mono text-micro uppercase tracking-wide text-ink-muted">
                    Reason
                  </dt>
                  <dd className="text-body text-ink">{item.reason}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-mono text-micro uppercase tracking-wide text-ink-muted">
                    Entity
                  </dt>
                  <dd className="text-body text-ink">{item.entity}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-mono text-micro uppercase tracking-wide text-ink-muted">
                    External ref
                  </dt>
                  <dd className="font-mono text-body text-ink">{item.external_ref ?? "—"}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-mono text-micro uppercase tracking-wide text-ink-muted">
                    Queued
                  </dt>
                  <dd className="font-mono text-body text-ink-secondary">
                    {formatTimestamp(item.created_at)}
                  </dd>
                </div>
              </dl>
              <div>
                <h3 className="font-mono text-micro uppercase tracking-wide text-ink-muted">
                  Payload — the row as Glofox sent it
                </h3>
                <pre className="mt-2 max-h-72 overflow-auto rounded-2 border border-hairline bg-surface-app p-3 font-mono text-chrome text-ink-secondary">
                  {JSON.stringify(item.payload, null, 2)}
                </pre>
              </div>
              {item.sync_run_id !== null && (
                <p className="text-body text-ink-secondary">
                  Caught by sync run{" "}
                  <span className="font-mono text-chrome">{item.sync_run_id}</span> —{" "}
                  <Link to="/health" className="text-link underline">
                    see recent runs on Health
                  </Link>
                </p>
              )}
            </div>
          )}
        </DataBoundary>
      </div>
    </aside>
  );
}

function ImportSkeleton() {
  return (
    <div role="status" aria-label="Loading import review" className="space-y-6">
      <span className="sr-only">Loading import review…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-24 w-full rounded-3" />
      <Skeleton className="h-40 w-full rounded-3" />
      <Skeleton className="h-40 w-full rounded-3" />
    </div>
  );
}

/**
 * Pure screen component — queries + the mutation are injected so tests mock
 * the query layer without a live API (the route wires the real ones).
 */
export function ImportReviewScreen({
  quarantineQuery,
  reconciliationQuery,
  resolver,
  detailQueryFor,
}: ImportReviewScreenProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dismissArmed, setDismissArmed] = useState(false);
  const [dismissNote, setDismissNote] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const pendingIds = resolver.status === "pending" ? (resolver.variables?.ids ?? []) : [];
  const confirmed =
    resolver.status === "success" && resolver.variables !== undefined
      ? { ids: resolver.variables.ids, status: resolver.variables.status }
      : null;

  // A confirmed commit clears the staging — the re-read queue is the truth now.
  useEffect(() => {
    if (resolver.status === "success") {
      setSelection(null);
      setDismissArmed(false);
      setDismissNote("");
    }
  }, [resolver.status]);

  const toggleRow = (key: string, id: string) => {
    // A new staging supersedes the previous commit's result banner.
    if (resolver.status === "success" || resolver.status === "error") {
      resolver.reset();
    }
    setSelection((current) => {
      if (current === null || current.key !== key) {
        return { key, ids: [id] };
      }
      const has = current.ids.includes(id);
      const ids = has ? current.ids.filter((value) => value !== id) : [...current.ids, id];
      return ids.length === 0 ? null : { key, ids };
    });
  };

  const clearSelection = () => {
    setSelection(null);
    setDismissArmed(false);
    setDismissNote("");
  };

  const commitResolve = () => {
    if (selection === null || selection.ids.length === 0) return;
    resolver.mutate({ ids: selection.ids, status: "resolved" });
  };

  const commitDismiss = () => {
    if (selection === null || selection.ids.length === 0 || dismissNote.trim() === "") return;
    resolver.mutate({ ids: selection.ids, status: "dismissed", note: dismissNote.trim() });
  };

  const activeCauseLabel = (data: QuarantineListData): string | null => {
    if (selection === null) return null;
    const cause = data.causes.find((candidate) => causeKey(candidate) === selection.key);
    return cause === undefined ? null : `${cause.entity} · ${cause.reason}`;
  };

  return (
    <div className="space-y-6">
      <DataBoundary<QuarantineListData>
        name="import-quarantine"
        query={quarantineQuery}
        skeleton={<ImportSkeleton />}
        errorConsequence="The import review queue didn't load — no exception was shown and no decision was taken."
      >
        {(data, meta) => (
          <div className="space-y-6">
            <PageHeader meta={meta} />
            <TotalsHeader data={data} />
            <ResultRegion resolver={resolver} />
            {data.causes.length === 0 ? (
              <EmptyState
                title="No open exceptions — the import is clean"
                body="Every imported row passed validation, or no import has run yet. Either way, nothing is waiting for a decision."
              />
            ) : (
              <div className="space-y-4">
                {data.causes.map((cause) => (
                  <CauseGroup
                    key={causeKey(cause)}
                    cause={cause}
                    rows={data.items.filter(
                      (item) => item.entity === cause.entity && item.reason === cause.reason,
                    )}
                    selection={selection}
                    activeLabel={activeCauseLabel(data)}
                    pendingIds={pendingIds}
                    confirmed={confirmed}
                    committing={resolver.status === "pending"}
                    dismissArmed={dismissArmed}
                    dismissNote={dismissNote}
                    onToggle={toggleRow}
                    onClearSelection={clearSelection}
                    onResolve={commitResolve}
                    onArmDismiss={() => setDismissArmed(true)}
                    onCancelDismiss={() => {
                      setDismissArmed(false);
                      setDismissNote("");
                    }}
                    onDismissNote={setDismissNote}
                    onConfirmDismiss={commitDismiss}
                    onOpenDetail={setDetailId}
                  />
                ))}
                {data.next_cursor !== null && (
                  <p className="text-chrome text-ink-muted">
                    Showing the {data.items.length} most recent open rows — deciding these pages the
                    next ones in.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </DataBoundary>

      <DataBoundary<ReconciliationsData>
        name="import-reconciliation"
        query={reconciliationQuery}
        skeleton={<Skeleton className="h-44 w-full rounded-3" />}
        errorConsequence="The reconciliation history didn't load — no comparison was shown and no decision was taken."
      >
        {(data) => (
          <Card title="Reconciliation — imported Glofox vs native Kelo">
            <ReconciliationRegion
              pending={data.reconciliation_pending}
              rows={data.reconciliations}
            />
          </Card>
        )}
      </DataBoundary>

      {detailId !== null && (
        <DetailDrawer
          id={detailId}
          onClose={() => setDetailId(null)}
          detailQueryFor={detailQueryFor}
        />
      )}
    </div>
  );
}
