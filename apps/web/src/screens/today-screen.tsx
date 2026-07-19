import { useMemo, useState, type ReactNode } from "react";
import type { EnvelopeMeta } from "@kelo/contracts";
import { Link } from "@tanstack/react-router";
import { BriefingArtifactView, BriefingStatusChip } from "../components/briefing-artifact.jsx";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "@kelo/ui/react";
import { FreshnessChip } from "@kelo/ui/react";
import { Skeleton } from "@kelo/ui/react";
import { ApiRequestError } from "../lib/api.js";
import { inspectEnvelope } from "../lib/envelope.js";
import type { FreshnessBucket } from "../lib/freshness.js";
import { aggregateFreshness, type HealthReport } from "../lib/health.js";
import { deviceTimeZone, formatTimestamp } from "../lib/time.js";
import type {
  BriefingArtifact,
  BriefingResponse,
  DefinitionsResponse,
  FeedbackMutationHandle,
  FocusDismissInput,
  FocusMutationHandle,
  FocusQueueItem,
  FocusQueueResponse,
  KpiKey,
  KpiMetric,
  KpiReport,
  MetricDefinition,
} from "../lib/today.js";

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleCaseKey(key: string): string {
  return key.replaceAll("_", " ");
}

function formatFact(key: string, value: number): string {
  const normalized = key.toLowerCase();
  if (
    normalized.includes("mrr") ||
    normalized.includes("sum") ||
    normalized.includes("net") ||
    normalized.includes("liability")
  ) {
    return MONEY.format(value);
  }
  if (normalized.includes("percent") || normalized.includes("rate")) {
    return `${NUMBER.format(value)}%`;
  }
  return NUMBER.format(value);
}

function formatBusinessDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.valueOf())) return date;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function deviceBusinessDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: deviceTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts();
  const part = (type: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function artifactFrom(
  query: BoundaryQuery,
): { artifact: BriefingArtifact; meta: EnvelopeMeta } | null {
  if (query.status !== "success") return null;
  const result = inspectEnvelope<BriefingResponse>(query.data);
  if (!result.ok || !isRecord(result.data) || !isRecord(result.data.artifact)) return null;
  return { artifact: result.data.artifact, meta: result.meta };
}

function isNotFound(query: BoundaryQuery): boolean {
  return (
    query.status === "error" && query.error instanceof ApiRequestError && query.error.status === 404
  );
}

function sourceFreshness(meta: EnvelopeMeta): {
  bucket: FreshnessBucket;
  minutesStale: number | null;
} {
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(meta.as_of)) / 60_000));
  if (meta.stale) {
    return age >= 240
      ? { bucket: "critical", minutesStale: age }
      : { bucket: "stale", minutesStale: Math.max(120, age) };
  }
  return age < 1 ? { bucket: "live", minutesStale: age } : { bucket: "synced", minutesStale: age };
}

function overallFreshness(
  healthQuery: BoundaryQuery,
  kpiQuery: BoundaryQuery,
): { bucket: FreshnessBucket; minutesStale: number | null } {
  if (healthQuery.status === "success") {
    const health = inspectEnvelope<HealthReport>(healthQuery.data);
    if (health.ok && Array.isArray(health.data.freshness)) {
      return aggregateFreshness(health.data.freshness);
    }
  }
  if (kpiQuery.status === "success") {
    const kpis = inspectEnvelope<KpiReport>(kpiQuery.data);
    if (kpis.ok) return sourceFreshness(kpis.meta);
  }
  return { bucket: "unknown", minutesStale: null };
}

function TodayHeader({
  briefingQuery,
  yesterdayQuery,
  healthQuery,
  kpiQuery,
}: {
  briefingQuery: BoundaryQuery;
  yesterdayQuery: BoundaryQuery;
  healthQuery: BoundaryQuery;
  kpiQuery: BoundaryQuery;
}) {
  const today = artifactFrom(briefingQuery);
  const fallback = artifactFrom(yesterdayQuery);
  const selected = today ?? fallback;
  const businessDate = selected?.artifact.generated_for ?? deviceBusinessDate();
  const freshness = overallFreshness(healthQuery, kpiQuery);
  const status = selected?.artifact.status ?? "absent";
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          Business date · studio time
        </p>
        <h1 className="mt-1 font-display text-title font-bold tracking-tight">
          {formatBusinessDate(businessDate)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-chrome text-ink-muted">
          <BriefingStatusChip status={status} yesterday={today === null && fallback !== null} />
          <span>
            {selected === null
              ? "Briefing not generated today"
              : `Generated ${formatTimestamp(selected.artifact.created_at)}`}
          </span>
          <span>· Times shown in {deviceTimeZone()}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-chrome text-ink-muted">Overall freshness</span>
        <FreshnessChip bucket={freshness.bucket} minutesStale={freshness.minutesStale} />
      </div>
    </header>
  );
}

function BriefingSkeleton() {
  return (
    <div role="status" aria-label="Loading briefing" className="space-y-3">
      <span className="sr-only">Loading briefing…</span>
      <Skeleton className="h-40 w-full rounded-3" />
      <Skeleton className="h-40 w-full rounded-3" />
    </div>
  );
}

function BriefingRegion({
  briefingQuery,
  yesterdayQuery,
  feedback,
}: {
  briefingQuery: BoundaryQuery;
  yesterdayQuery: BoundaryQuery;
  feedback: FeedbackMutationHandle;
}) {
  if (!isNotFound(briefingQuery)) {
    return (
      <DataBoundary<BriefingResponse>
        name="today-briefing"
        query={briefingQuery}
        skeleton={<BriefingSkeleton />}
        errorConsequence="The briefing didn't load — KPIs and the focus queue were not affected."
      >
        {(data) => (
          <BriefingArtifactView artifact={data.artifact} yesterday={false} feedback={feedback} />
        )}
      </DataBoundary>
    );
  }
  if (isNotFound(yesterdayQuery)) {
    return (
      <EmptyState
        title="No briefing yet — generated daily at 6:00 AM studio time"
        body="Neither today's nor yesterday's briefing exists. KPIs and the focus queue can still load independently."
      />
    );
  }
  return (
    <DataBoundary<BriefingResponse>
      name="yesterday-briefing"
      query={yesterdayQuery}
      skeleton={<BriefingSkeleton />}
      errorConsequence="Neither today's nor yesterday's briefing loaded — KPIs and the focus queue were not affected."
      staleState={null}
    >
      {(data, meta) => (
        <BriefingArtifactView artifact={data.artifact} yesterday={meta.stale} feedback={feedback} />
      )}
    </DataBoundary>
  );
}

const KPI_KEYS: KpiKey[] = [
  "member_count",
  "mrr",
  "collected_30d",
  "failed_payments",
  "credit_liability",
  "attendance_30d",
];

const KPI_LABELS: Record<KpiKey, string> = {
  member_count: "Member count",
  mrr: "MRR",
  collected_30d: "Collected 30d",
  failed_payments: "Failed payments",
  credit_liability: "Credit liability",
  attendance_30d: "Attendance rate",
};

function validMetric(key: KpiKey, metric: unknown): metric is KpiMetric {
  if (!isRecord(metric) || !isRecord(metric["definition"])) return false;
  const definition = metric["definition"];
  if (typeof definition["key"] !== "string" || typeof definition["version"] !== "number") {
    return false;
  }
  const value = metric["value"];
  if (key === "member_count") return typeof value === "number";
  if (!isRecord(value)) return false;
  switch (key) {
    case "mrr":
      return typeof value["mrr"] === "number";
    case "collected_30d":
      return typeof value["net"] === "number";
    case "failed_payments":
      return typeof value["failed_count"] === "number" && typeof value["failed_sum"] === "number";
    case "credit_liability":
      return typeof value["est_liability"] === "number";
    case "attendance_30d":
      return typeof value["attendance_rate"] === "number";
  }
}

function metricQuery(query: BoundaryQuery, key: KpiKey): BoundaryQuery {
  if (query.status !== "success") return query;
  const inspected = inspectEnvelope<Record<string, unknown>>(query.data);
  if (!inspected.ok) return query;
  const metric = inspected.data[key];
  if (!validMetric(key, metric)) {
    return {
      status: "error",
      error: new Error(`${KPI_LABELS[key]} was missing or invalid in the KPI response.`),
      refetch: query.refetch,
    };
  }
  return {
    status: "success",
    data: { data: metric, meta: inspected.meta },
    isRefetching: query.isRefetching,
    refetch: query.refetch,
  };
}

function kpiValue(key: KpiKey, value: unknown): { primary: string; detail?: string } {
  if (key === "member_count" && typeof value === "number") {
    return { primary: NUMBER.format(value) };
  }
  if (!isRecord(value)) return { primary: "—" };
  switch (key) {
    case "mrr":
      return {
        primary: MONEY.format(Number(value["mrr"])),
        detail: `${NUMBER.format(Number(value["contributing_members"]))} contributing members`,
      };
    case "collected_30d":
      return {
        primary: MONEY.format(Number(value["net"])),
        detail: `${NUMBER.format(Number(value["txn_count"]))} transactions`,
      };
    case "failed_payments":
      return {
        primary: NUMBER.format(Number(value["failed_count"])),
        detail: `${MONEY.format(Number(value["failed_sum"]))} outstanding`,
      };
    case "credit_liability":
      return {
        primary: MONEY.format(Number(value["est_liability"])),
        detail: `${NUMBER.format(Number(value["outstanding_credits"]))} credits${value["approximate"] === true ? " · approximate" : ""}`,
      };
    case "attendance_30d":
      return {
        primary: `${NUMBER.format(Number(value["attendance_rate"]))}%`,
        detail: `${NUMBER.format(Number(value["attended"]))} attended`,
      };
    case "member_count":
      return { primary: "—" };
  }
}

function definitionFrom(
  query: BoundaryQuery,
  reference: KpiMetric["definition"],
): MetricDefinition | null {
  if (query.status !== "success") return null;
  const inspected = inspectEnvelope<DefinitionsResponse>(query.data);
  if (!inspected.ok || !Array.isArray(inspected.data.definitions)) return null;
  return (
    inspected.data.definitions.find(
      (item) => item.key === reference.key && item.version === reference.version,
    ) ?? null
  );
}

function DefinitionTooltip({
  label,
  reference,
  definitionQuery,
}: {
  label: string;
  reference: KpiMetric["definition"];
  definitionQuery: BoundaryQuery;
}) {
  const definition = definitionFrom(definitionQuery, reference);
  const body =
    definitionQuery.status === "pending"
      ? "Definition loading…"
      : definitionQuery.status === "error"
        ? "Definition unavailable — the KPI value is still shown from its own response."
        : (definition?.definition ?? "No matching dictionary definition was returned.");
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`Definition for ${label}`}
        aria-describedby={`definition-${reference.key}-${reference.version}`}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full text-link hover:bg-ghost-hover"
      >
        ⓘ
      </button>
      <span
        id={`definition-${reference.key}-${reference.version}`}
        role="tooltip"
        className="invisible absolute bottom-full left-0 z-40 w-72 rounded-2 border border-border-strong bg-surface-card p-3 text-body text-ink-secondary shadow-2 group-hover:visible group-focus-within:visible"
      >
        {body}
        <span className="mt-2 block font-mono text-micro uppercase tracking-wide text-ink-muted">
          {reference.key} · v{reference.version}
        </span>
      </span>
    </span>
  );
}

function KpiTile({
  kpiKey,
  query,
  definitionQuery,
}: {
  kpiKey: KpiKey;
  query: BoundaryQuery;
  definitionQuery: BoundaryQuery;
}) {
  return (
    <DataBoundary<KpiMetric>
      name={`today-kpi-${kpiKey}`}
      query={query}
      skeleton={<Skeleton className="h-40 w-full rounded-3" />}
      errorConsequence={`${KPI_LABELS[kpiKey]} isn't shown. The other KPI tiles were not affected.`}
    >
      {(metric, meta) => {
        const display = kpiValue(kpiKey, metric.value);
        const freshness = sourceFreshness(meta);
        return (
          <article className="h-full rounded-3 border border-hairline bg-surface-card p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-mono text-micro uppercase tracking-wide text-ink-muted">
                {KPI_LABELS[kpiKey]}
              </h3>
              <DefinitionTooltip
                label={KPI_LABELS[kpiKey]}
                reference={metric.definition}
                definitionQuery={definitionQuery}
              />
            </div>
            <p className="mt-3 font-mono text-title font-bold text-ink">{display.primary}</p>
            {display.detail !== undefined && (
              <p className="mt-1 font-mono text-chrome text-ink-secondary">{display.detail}</p>
            )}
            <div className="mt-4">
              <FreshnessChip bucket={freshness.bucket} minutesStale={freshness.minutesStale} />
            </div>
            {/* TODO(today-reports): make the whole tile tap through when report routes ship. */}
          </article>
        );
      }}
    </DataBoundary>
  );
}

function KpiGrid({
  query,
  definitionQuery,
}: {
  query: BoundaryQuery;
  definitionQuery: BoundaryQuery;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {KPI_KEYS.map((key) => (
        <KpiTile
          key={key}
          kpiKey={key}
          query={metricQuery(query, key)}
          definitionQuery={definitionQuery}
        />
      ))}
    </div>
  );
}

function personName(item: FocusQueueItem): string {
  const first = typeof item.facts["first_name"] === "string" ? item.facts["first_name"] : "";
  const last = typeof item.facts["last_name"] === "string" ? item.facts["last_name"] : "";
  const name = `${first} ${last}`.trim();
  return name === "" ? "Name unavailable" : name;
}

function numericFacts(
  value: Record<string, unknown>,
  prefix = "",
): Array<{
  label: string;
  value: string;
}> {
  return Object.entries(value).flatMap(([key, fact]) => {
    if (["first_name", "last_name", "person_id"].includes(key)) return [];
    const label = prefix === "" ? titleCaseKey(key) : `${prefix} ${titleCaseKey(key)}`;
    if (typeof fact === "number" && Number.isFinite(fact)) {
      return [{ label, value: formatFact(key, fact) }];
    }
    return isRecord(fact) ? numericFacts(fact, label) : [];
  });
}

function nextStudioMorning(businessDate: string): string {
  const date = new Date(`${businessDate}T12:00:00`);
  if (Number.isNaN(date.valueOf())) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 1);
    fallback.setHours(6, 0, 0, 0);
    return fallback.toISOString();
  }
  date.setDate(date.getDate() + 1);
  date.setHours(6, 0, 0, 0);
  return date.toISOString();
}

function FocusRow({
  item,
  businessDate,
  mutation,
  onConfirmed,
}: {
  item: FocusQueueItem;
  businessDate: string;
  mutation: FocusMutationHandle;
  onConfirmed: (itemKey: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<FocusDismissInput["action"] | null>(null);
  const [error, setError] = useState(false);
  const facts = numericFacts(item.facts);

  const commit = (input: FocusDismissInput) => {
    setPending(input.action);
    setError(false);
    mutation.mutate(input, {
      onSuccess: () => onConfirmed(item.item_key),
      onError: () => {
        setPending(null);
        setError(true);
      },
    });
  };

  return (
    <li className="rounded-3 border border-hairline bg-surface-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-body font-medium text-ink">{personName(item)}</p>
          <p className="mt-1 font-mono text-micro uppercase tracking-wide text-ink-muted">
            {titleCaseKey(item.category)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={pending !== null}
            onClick={() => setDialogOpen(true)}
          >
            Dismiss…
          </Button>
          <Button
            variant="ghost"
            disabled={pending !== null}
            onClick={() =>
              commit({
                item_key: item.item_key,
                action: "snoozed",
                snooze_until: nextStudioMorning(businessDate),
              })
            }
          >
            Snooze until tomorrow
          </Button>
        </div>
      </div>
      <div className="mt-3">
        {facts.length === 0 ? (
          <p className="text-chrome text-ink-muted">No numeric situation facts were returned.</p>
        ) : (
          <ul
            aria-label={`Situation facts for ${personName(item)}`}
            className="flex flex-wrap gap-2"
          >
            {facts.map((fact) => (
              <li
                key={`${fact.label}:${fact.value}`}
                className="rounded-full border border-hairline bg-surface-app px-2 py-1 font-mono text-micro uppercase tracking-wide text-ink-secondary"
              >
                {fact.label} · {fact.value}
              </li>
            ))}
          </ul>
        )}
      </div>
      {pending !== null && (
        <p role="status" className="mt-3 text-chrome text-ink-muted">
          {pending === "dismissed" ? "Saving dismissal…" : "Saving snooze…"} This row stays until
          the server confirms.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-body text-danger-on-tint">
          The server didn&apos;t confirm this change. The row was not removed.
        </p>
      )}
      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`dismiss-title-${item.item_key}`}
          className="fixed inset-0 z-40 flex items-center justify-center bg-surface-inverse p-4"
        >
          <div className="w-full max-w-sm rounded-3 border border-border-strong bg-surface-card p-6 shadow-3">
            <h3 id={`dismiss-title-${item.item_key}`} className="font-display text-title font-bold">
              Dismiss {personName(item)}?
            </h3>
            <p className="mt-2 text-body text-ink-secondary">
              Give a reason so repeated dismissals can improve the queue.
            </p>
            <label
              className="mt-4 block text-body font-medium text-ink"
              htmlFor={`reason-${item.item_key}`}
            >
              Dismissal reason
            </label>
            <textarea
              id={`reason-${item.item_key}`}
              value={reason}
              required
              rows={3}
              className="mt-1 w-full rounded-2 border border-input-border bg-surface-input p-3 text-body text-ink"
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={pending !== null}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={reason.trim() === "" || pending !== null}
                onClick={() =>
                  commit({ item_key: item.item_key, action: "dismissed", reason: reason.trim() })
                }
              >
                Dismiss with reason
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

const FOCUS_ORDER: Record<FocusQueueItem["category"], number> = {
  payment_risk: 0,
  at_risk: 1,
  credits_expiring: 2,
  hooked: 3,
};

function FocusQueue({
  items,
  businessDate,
  mutation,
}: {
  items: FocusQueueItem[];
  businessDate: string;
  mutation: FocusMutationHandle;
}) {
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
  const visible = useMemo(
    () =>
      [...items]
        .filter((item) => !confirmed.has(item.item_key))
        .sort((a, b) => FOCUS_ORDER[a.category] - FOCUS_ORDER[b.category]),
    [confirmed, items],
  );
  const groups = [
    { title: "Money", items: visible.filter((item) => item.category === "payment_risk") },
    { title: "People", items: visible.filter((item) => item.category !== "payment_risk") },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) {
    return (
      <EmptyState
        title="Queue clear — nothing needs you right now."
        body="This is a real empty state from the current focus-queue response, not a sync placeholder."
      />
    );
  }
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.title} aria-labelledby={`focus-${group.title.toLowerCase()}`}>
          <h3
            id={`focus-${group.title.toLowerCase()}`}
            className="font-mono text-micro uppercase tracking-wide text-ink-muted"
          >
            {group.title}
          </h3>
          <ul className="mt-2 space-y-3">
            {group.items.map((item) => (
              <FocusRow
                key={item.item_key}
                item={item}
                businessDate={businessDate}
                mutation={mutation}
                onConfirmed={(itemKey) => setConfirmed((current) => new Set([...current, itemKey]))}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FocusSkeleton() {
  return (
    <div role="status" aria-label="Loading focus queue" className="space-y-3">
      <span className="sr-only">Loading focus queue…</span>
      <Skeleton className="h-32 w-full rounded-3" />
      <Skeleton className="h-32 w-full rounded-3" />
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const id = `today-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={id} className="font-display text-title font-bold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export interface TodayScreenProps {
  briefingQuery: BoundaryQuery;
  yesterdayQuery: BoundaryQuery;
  kpiQuery: BoundaryQuery;
  definitionsQuery: BoundaryQuery;
  focusQuery: BoundaryQuery;
  healthQuery: BoundaryQuery;
  feedback: FeedbackMutationHandle;
  focusMutation: FocusMutationHandle;
}

/** Pure morning surface; routes inject the query and mutation layer for testability. */
export function TodayScreen({
  briefingQuery,
  yesterdayQuery,
  kpiQuery,
  definitionsQuery,
  focusQuery,
  healthQuery,
  feedback,
  focusMutation,
}: TodayScreenProps) {
  const today = artifactFrom(briefingQuery);
  const fallback = artifactFrom(yesterdayQuery);
  const businessDate =
    today?.artifact.generated_for ?? fallback?.artifact.generated_for ?? deviceBusinessDate();
  return (
    <div className="space-y-6">
      <TodayHeader
        briefingQuery={briefingQuery}
        yesterdayQuery={yesterdayQuery}
        healthQuery={healthQuery}
        kpiQuery={kpiQuery}
      />
      <Section title="Morning briefing" action={<Link to="/briefing/archive" className="text-body font-medium text-link underline hover:text-link-hover">View archive</Link>}>
        <BriefingRegion
          briefingQuery={briefingQuery}
          yesterdayQuery={yesterdayQuery}
          feedback={feedback}
        />
      </Section>
      <Section title="Key indicators">
        <KpiGrid query={kpiQuery} definitionQuery={definitionsQuery} />
      </Section>
      <Section title="Focus queue">
        <DataBoundary<FocusQueueResponse>
          name="today-focus-queue"
          query={focusQuery}
          skeleton={<FocusSkeleton />}
          errorConsequence="The focus queue didn't load — no item was dismissed or snoozed, and the briefing and KPIs were not affected."
          isEmpty={(data) => data.items.length === 0}
          emptyState={
            <EmptyState
              title="Queue clear — nothing needs you right now."
              body="This is a real empty state from the current focus-queue response, not a sync placeholder."
            />
          }
        >
          {(data) => (
            <FocusQueue items={data.items} businessDate={businessDate} mutation={focusMutation} />
          )}
        </DataBoundary>
      </Section>
    </div>
  );
}
