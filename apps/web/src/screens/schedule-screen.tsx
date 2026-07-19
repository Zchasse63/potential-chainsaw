import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { deviceTimeZone, formatTimestamp } from "../lib/time.js";
import type { HeatmapResponse } from "../lib/intelligence.js";
import {
  READINESS_STATES,
  RESOURCE_KINDS,
  resolveWallTime,
  studioClock,
  studioDate,
  studioDateTime,
  humanWeekday,
  weekColumns,
  type OfferingTemplateRow,
  type ReadinessRow,
  type ReadinessState,
  type ResourceKind,
  type ResourceRow,
  type ScheduledSessionRow,
  type SchedulingActions,
  type SchedulingOverview,
  type SessionStatus,
} from "../lib/scheduling.js";

const DAYS = [{ dow: 1, label: "Mon" }, { dow: 2, label: "Tue" }, { dow: 3, label: "Wed" }, { dow: 4, label: "Thu" }, { dow: 5, label: "Fri" }, { dow: 6, label: "Sat" }, { dow: 0, label: "Sun" }];
const DAYPARTS = [{ key: "morning", label: "Morning", hours: "6–11" }, { key: "midday", label: "Midday", hours: "11–16" }, { key: "evening", label: "Evening", hours: "16–21" }];

function tint(fill: number): string {
  if (fill >= 0.75) return "bg-fill-4";
  if (fill >= 0.5) return "bg-fill-3";
  if (fill >= 0.25) return "bg-fill-2";
  return "bg-fill-1";
}

function keyOf(dow: number, daypart: string) { return `${dow}:${daypart}`; }

function Heatmap({ data }: { data: HeatmapResponse }) {
  const cells = useMemo(() => new Map(data.cells.map((cell) => [keyOf(cell.dow, cell.daypart), cell])), [data.cells]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = selectedKey === null ? undefined : cells.get(selectedKey);
  return (
    <div className="space-y-5">
      <div className="overflow-x-auto rounded-3 border border-hairline bg-surface-card p-4">
        <div role="grid" aria-label="30-day fill by weekday and daypart" className="grid min-w-full grid-cols-4 gap-2">
          <div />{DAYPARTS.map((part) => <div key={part.key} role="columnheader" className="px-2 py-1 text-center"><span className="font-mono text-micro uppercase tracking-wide text-ink-muted">{part.label}</span><span className="block text-chrome text-ink-muted">{part.hours}</span></div>)}
          {DAYS.flatMap((day) => {
            const row = [<div key={`${day.dow}:label`} role="rowheader" className="flex items-center font-mono text-table font-medium text-ink-secondary">{day.label}</div>];
            for (const part of DAYPARTS) {
              const cell = cells.get(keyOf(day.dow, part.key));
              const fill = cell?.fill ?? 0;
              const key = keyOf(day.dow, part.key);
              row.push(<button key={key} type="button" role="gridcell" aria-label={`${day.label} ${part.label}: ${Math.round(fill * 100)}% fill, ${cell?.sessions ?? 0} sessions`} aria-pressed={selectedKey === key} onMouseEnter={() => setSelectedKey(key)} onFocus={() => setSelectedKey(key)} onClick={() => setSelectedKey(key)} className={`min-h-20 rounded-2 border p-2 text-left focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 ${selectedKey === key ? "border-selected-border" : "border-hairline"} ${tint(fill)}`}><span className="block font-mono text-title font-bold text-ink">{Math.round(fill * 100)}%</span><span className="mt-1 block text-chrome text-ink-secondary">{cell?.sessions ?? 0} sessions · {cell?.booked ?? 0}/{cell?.capacity ?? 0}</span></button>);
            }
            return row;
          })}
        </div>
      </div>
      <section aria-labelledby="heatmap-sessions">
        <h2 id="heatmap-sessions" className="font-display text-title font-bold">Sessions behind the selected cell</h2>
        {selected === undefined ? <p className="mt-2 text-body text-ink-secondary">Hover, focus, or select a cell to disclose its source sessions.</p> : selected.underlying_sessions.length === 0 ? <div className="mt-3"><EmptyState title="No sessions in this cell." body="The zero is from the selected 30-day weekday/daypart window." /></div> : <ul className="mt-3 divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">{selected.underlying_sessions.map((session) => <li key={session.session_id} className="flex flex-wrap items-center justify-between gap-2 p-3"><div><p className="text-body font-medium text-ink">{session.name ?? "Unnamed imported session"}</p><p className="text-chrome text-ink-muted">{formatTimestamp(session.time_start)} · {deviceTimeZone()}</p></div><p className="font-mono text-table text-ink-secondary">{session.booked}/{session.capacity} booked</p></li>)}</ul>}
      </section>
    </div>
  );
}

function HeatmapView({ query }: { query: BoundaryQuery }) {
  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Schedule tuning · phase 2 approximation</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight">30-day fill heatmap</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">Cell tint is booked capacity ÷ imported session capacity. It is fill, not demand. Turnover and room-readiness modeling arrive in phase 4.</p>
      </header>
      <DataBoundary<HeatmapResponse> name="schedule-fill-heatmap" query={query} skeleton={<Skeleton className="h-96 w-full rounded-3" />} errorConsequence="The fill heatmap didn't load; no schedule data was changed.">{(data) => <Heatmap data={data} />}</DataBoundary>
    </div>
  );
}

// -- Authoring tab -----------------------------------------------------------

const FIELD_LABEL = "block text-body font-medium text-ink";
const FIELD_CONTROL = "mt-1 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";

const SESSION_BADGE: Record<SessionStatus, { marker: string; label: string; classes: string }> = {
  draft: { marker: "▹", label: "Draft", classes: "border-warning-border bg-warning-tint text-warning-on-tint" },
  published: { marker: "✓", label: "Published", classes: "border-success-border bg-success-tint text-success-on-tint" },
  cancelled: { marker: "✕", label: "Cancelled", classes: "border-hairline bg-surface-app text-ink-muted" },
};

function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const badge = SESSION_BADGE[status];
  return (
    <span data-testid={`session-status-${status}`} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${badge.classes}`}>
      <span aria-hidden="true">{badge.marker}</span>
      {badge.label}
    </span>
  );
}

const READINESS_BADGE: Record<ReadinessState, { marker: string; label: string; classes: string }> = {
  ready: { marker: "✓", label: "Ready", classes: "border-success-border bg-success-tint text-success-on-tint" },
  turnover: { marker: "↻", label: "Turnover", classes: "border-info-border bg-info-tint text-info-on-tint" },
  maintenance: { marker: "▲", label: "Maintenance", classes: "border-warning-border bg-warning-tint text-warning-on-tint" },
  closed: { marker: "✕", label: "Closed", classes: "border-danger-border bg-danger-tint text-danger-on-tint" },
};

function ReadinessBadge({ state }: { state: ReadinessState }) {
  const badge = READINESS_BADGE[state];
  return (
    <span data-testid={`readiness-${state}`} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${badge.classes}`}>
      <span aria-hidden="true">{badge.marker}</span>
      {badge.label}
    </span>
  );
}

function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  const id = `authoring-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section aria-labelledby={id} className="rounded-3 border border-hairline bg-surface-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={id} className="font-display text-title font-bold tracking-tight text-ink">{title}</h2>
          {description !== undefined && <p className="mt-1 max-w-2xl text-body text-ink-secondary">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function currentReadiness(readiness: ReadinessRow[], resourceId: string, now: number): ReadinessState {
  const active = readiness
    .filter((row) => row.resource_id === resourceId)
    .filter((row) => Date.parse(row.effective_from) <= now && (row.effective_to === null || Date.parse(row.effective_to) > now))
    .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from));
  return active[0]?.state ?? "ready";
}

function ResourceForm({ resource, actions, onDone }: { resource?: ResourceRow; actions: SchedulingActions; onDone: () => void }) {
  const [name, setName] = useState(resource?.name ?? "");
  const [kind, setKind] = useState<ResourceKind>(resource?.kind ?? "room");
  const [capacity, setCapacity] = useState(String(resource?.capacity ?? 1));
  const [active, setActive] = useState(resource?.active ?? true);
  const [error, setError] = useState(false);
  const editing = resource !== undefined;
  const pending = editing ? actions.updateResource.pending : actions.createResource.pending;
  const cap = Number(capacity);
  const valid = name.trim() !== "" && Number.isInteger(cap) && cap >= 1;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setError(false);
    const callbacks = { onSuccess: onDone, onError: () => setError(true) };
    if (editing) actions.updateResource.mutate({ id: resource.id, name: name.trim(), kind, capacity: cap, active }, callbacks);
    else actions.createResource.mutate({ name: name.trim(), kind, capacity: cap }, callbacks);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-2 border border-hairline bg-surface-app p-3 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <label className={FIELD_LABEL} htmlFor={`resource-name-${resource?.id ?? "new"}`}>Name</label>
        <input id={`resource-name-${resource?.id ?? "new"}`} value={name} onChange={(event) => setName(event.target.value)} className={FIELD_CONTROL} />
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor={`resource-kind-${resource?.id ?? "new"}`}>Kind</label>
        <select id={`resource-kind-${resource?.id ?? "new"}`} value={kind} onChange={(event) => setKind(event.target.value as ResourceKind)} className={FIELD_CONTROL}>
          {RESOURCE_KINDS.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
        </select>
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor={`resource-capacity-${resource?.id ?? "new"}`}>Capacity</label>
        <input id={`resource-capacity-${resource?.id ?? "new"}`} inputMode="numeric" value={capacity} onChange={(event) => setCapacity(event.target.value.replace(/\D/g, ""))} className={FIELD_CONTROL} />
      </div>
      {editing && (
        <label className="flex items-center gap-2 text-body text-ink-secondary sm:col-span-4">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          Active (bookable)
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
        <Button type="submit" disabled={!valid || pending}>{pending ? "Saving…" : editing ? "Save resource" : "Add resource"}</Button>
        {editing && <Button variant="ghost" onClick={onDone} disabled={pending}>Cancel</Button>}
        {error && <span role="alert" className="text-body text-danger-on-tint">The server didn&apos;t confirm this change; nothing was saved.</span>}
      </div>
    </form>
  );
}

function ReadinessControl({ resource, current, actions }: { resource: ResourceRow; current: ReadinessState; actions: SchedulingActions }) {
  const [state, setState] = useState<ReadinessState>(current);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ReadinessBadge state={current} />
      <label className="sr-only" htmlFor={`readiness-select-${resource.id}`}>Set readiness for {resource.name}</label>
      <select
        id={`readiness-select-${resource.id}`}
        value={state}
        onChange={(event) => { setState(event.target.value as ReadinessState); setSaved(false); setError(false); }}
        className="h-9 rounded-2 border border-input-border bg-surface-input px-2 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
      >
        {READINESS_STATES.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <Button
        variant="secondary"
        className="h-9"
        disabled={actions.setReadiness.pending}
        onClick={() => {
          setError(false);
          actions.setReadiness.mutate(
            { resource_id: resource.id, state, effective_from: new Date().toISOString(), note: null },
            { onSuccess: () => setSaved(true), onError: () => setError(true) },
          );
        }}
      >
        Set
      </Button>
      {saved && <span role="status" className="text-chrome text-ink-muted">Saved after server confirmation.</span>}
      {error && <span role="alert" className="text-chrome text-danger-on-tint">Not saved.</span>}
    </div>
  );
}

function ResourcesSection({ data, actions }: { data: SchedulingOverview; actions: SchedulingActions }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const now = Date.now();
  return (
    <Section
      title="Resources"
      description="Rooms, equipment, and trainer slots the schedule books against. Set a readiness state to take a resource out of service without deleting it."
      action={<Button variant="secondary" onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "Add resource"}</Button>}
    >
      {adding && <div className="mb-4"><ResourceForm actions={actions} onDone={() => setAdding(false)} /></div>}
      {data.resources.length === 0 ? (
        <EmptyState title="No resources yet." body="This is a real empty state from the current tenant, not a sync gap. Add a room or plunge to start scheduling." />
      ) : (
        <ul className="divide-y divide-hairline">
          {data.resources.map((resource) => (
            <li key={resource.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-body font-medium text-ink">{resource.name}{!resource.active && <span className="ml-2 font-mono text-micro uppercase tracking-wide text-ink-muted">Inactive</span>}</p>
                  <p className="mt-1 font-mono text-micro uppercase tracking-wide text-ink-muted">{resource.kind.replaceAll("_", " ")} · capacity {resource.capacity}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <ReadinessControl resource={resource} current={currentReadiness(data.readiness, resource.id, now)} actions={actions} />
                  <Button variant="ghost" className="h-9" onClick={() => setEditingId((current) => (current === resource.id ? null : resource.id))}>{editingId === resource.id ? "Close edit" : "Edit"}</Button>
                </div>
              </div>
              {editingId === resource.id && <div className="mt-3"><ResourceForm resource={resource} actions={actions} onDone={() => setEditingId(null)} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function TemplateForm({ template, actions, onDone }: { template?: OfferingTemplateRow; actions: SchedulingActions; onDone: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [duration, setDuration] = useState(String(template?.duration_minutes ?? 50));
  const [defaultCapacity, setDefaultCapacity] = useState(template?.default_capacity === null || template?.default_capacity === undefined ? "" : String(template.default_capacity));
  const [active, setActive] = useState(template?.active ?? true);
  const [error, setError] = useState(false);
  const editing = template !== undefined;
  const pending = editing ? actions.updateTemplate.pending : actions.createTemplate.pending;
  const dur = Number(duration);
  const capValue = defaultCapacity.trim() === "" ? null : Number(defaultCapacity);
  const valid = name.trim() !== "" && Number.isInteger(dur) && dur >= 1 && (capValue === null || (Number.isInteger(capValue) && capValue >= 1));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setError(false);
    const callbacks = { onSuccess: onDone, onError: () => setError(true) };
    if (editing) actions.updateTemplate.mutate({ id: template.id, name: name.trim(), duration_minutes: dur, default_capacity: capValue, active }, callbacks);
    else actions.createTemplate.mutate({ name: name.trim(), duration_minutes: dur, default_capacity: capValue }, callbacks);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-2 border border-hairline bg-surface-app p-3 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <label className={FIELD_LABEL} htmlFor={`template-name-${template?.id ?? "new"}`}>Name</label>
        <input id={`template-name-${template?.id ?? "new"}`} value={name} onChange={(event) => setName(event.target.value)} className={FIELD_CONTROL} />
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor={`template-duration-${template?.id ?? "new"}`}>Duration (min)</label>
        <input id={`template-duration-${template?.id ?? "new"}`} inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value.replace(/\D/g, ""))} className={FIELD_CONTROL} />
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor={`template-capacity-${template?.id ?? "new"}`}>Default capacity</label>
        <input id={`template-capacity-${template?.id ?? "new"}`} inputMode="numeric" placeholder="Resource default" value={defaultCapacity} onChange={(event) => setDefaultCapacity(event.target.value.replace(/\D/g, ""))} className={FIELD_CONTROL} />
      </div>
      {editing && (
        <label className="flex items-center gap-2 text-body text-ink-secondary sm:col-span-4">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          Active (offerable)
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
        <Button type="submit" disabled={!valid || pending}>{pending ? "Saving…" : editing ? "Save template" : "Add template"}</Button>
        {editing && <Button variant="ghost" onClick={onDone} disabled={pending}>Cancel</Button>}
        {error && <span role="alert" className="text-body text-danger-on-tint">The server didn&apos;t confirm this change; nothing was saved.</span>}
      </div>
    </form>
  );
}

function TemplatesSection({ data, actions }: { data: SchedulingOverview; actions: SchedulingActions }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <Section
      title="Offering templates"
      description="The reusable shape of a session — its name, length, and default capacity. Sessions inherit these when created."
      action={<Button variant="secondary" onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "Add template"}</Button>}
    >
      {adding && <div className="mb-4"><TemplateForm actions={actions} onDone={() => setAdding(false)} /></div>}
      {data.offering_templates.length === 0 ? (
        <EmptyState title="No offering templates yet." body="A real empty state, not a sync gap. Add a template (for example, a 50-minute contrast session) to schedule against it." />
      ) : (
        <ul className="divide-y divide-hairline">
          {data.offering_templates.map((template) => (
            <li key={template.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-body font-medium text-ink">{template.name}{!template.active && <span className="ml-2 font-mono text-micro uppercase tracking-wide text-ink-muted">Inactive</span>}</p>
                  <p className="mt-1 font-mono text-micro uppercase tracking-wide text-ink-muted">{template.duration_minutes} min · default capacity {template.default_capacity ?? "resource"}</p>
                </div>
                <Button variant="ghost" className="h-9" onClick={() => setEditingId((current) => (current === template.id ? null : template.id))}>{editingId === template.id ? "Close edit" : "Edit"}</Button>
              </div>
              {editingId === template.id && <div className="mt-3"><TemplateForm template={template} actions={actions} onDone={() => setEditingId(null)} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CreateSessionForm({ data, actions }: { data: SchedulingOverview; actions: SchedulingActions }) {
  const templates = data.offering_templates.filter((template) => template.active);
  const resources = data.resources.filter((resource) => resource.active);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? "");
  const [localDate, setLocalDate] = useState(studioDate(new Date(), data.timezone));
  const [localTime, setLocalTime] = useState("06:00");
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const resolved = resolveWallTime(localDate, localTime, data.timezone);
  const complete = templateId !== "" && resourceId !== "";
  const canSubmit = complete && resolved.ok && !actions.createSession.pending;

  if (templates.length === 0 || resources.length === 0) {
    return <EmptyState title="Add a template and an active resource first." body="A session needs an offering template and a bookable resource. This is a real prerequisite, not a sync gap." />;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || !resolved.ok) return;
    setError(false);
    actions.createSession.mutate(
      { offering_template_id: templateId, resource_id: resourceId, local_date: localDate, local_start_time: localTime },
      { onSuccess: () => setSaved(true), onError: () => setError(true) },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-2 border border-hairline bg-surface-app p-3 sm:grid-cols-2">
      <div>
        <label className={FIELD_LABEL} htmlFor="session-template">Offering template</label>
        <select id="session-template" value={templateId} onChange={(event) => { setTemplateId(event.target.value); setSaved(false); }} className={FIELD_CONTROL}>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.duration_minutes} min</option>)}
        </select>
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor="session-resource">Resource</label>
        <select id="session-resource" value={resourceId} onChange={(event) => { setResourceId(event.target.value); setSaved(false); }} className={FIELD_CONTROL}>
          {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
        </select>
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor="session-date">Local date</label>
        <input id="session-date" type="date" value={localDate} onChange={(event) => { setLocalDate(event.target.value); setSaved(false); }} className={FIELD_CONTROL} />
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor="session-time">Local start (HH:MM)</label>
        <input id="session-time" type="time" value={localTime} onChange={(event) => { setLocalTime(event.target.value); setSaved(false); }} className={FIELD_CONTROL} />
      </div>
      <div className="rounded-2 border border-info-border bg-info-tint p-3 sm:col-span-2" data-testid="session-time-preview" aria-live="polite">
        {resolved.ok ? (
          <p className="text-body text-info-on-tint">
            Resolves to <span className="font-medium">{studioDateTime(resolved.instant, data.timezone)}</span>
            <span className="ml-1 font-mono text-chrome">({data.timezone})</span>
          </p>
        ) : resolved.reason === "nonexistent" ? (
          <p className="text-body text-danger-on-tint">{localDate} {localTime} does not exist in {data.timezone} because of a daylight-saving transition. Choose another time.</p>
        ) : (
          <p className="text-body text-info-on-tint">Enter a valid date and time to preview the resolved absolute start in {data.timezone}.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" disabled={!canSubmit}>{actions.createSession.pending ? "Creating draft…" : "Create draft session"}</Button>
        {saved && <span role="status" className="text-body text-success-on-tint">Draft created after server confirmation.</span>}
        {error && <span role="alert" className="text-body text-danger-on-tint">The server didn&apos;t confirm; no draft was created.</span>}
      </div>
    </form>
  );
}

function PublishDialog({ draftIds, actions, onClose }: { draftIds: string[]; actions: SchedulingActions; onClose: () => void }) {
  const [error, setError] = useState(false);
  const count = draftIds.length;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title" className="fixed inset-0 z-40 flex items-center justify-center bg-surface-inverse p-4">
      <div className="w-full max-w-sm rounded-3 border border-border-strong bg-surface-card p-6 shadow-3">
        <h3 id="publish-dialog-title" className="font-display text-title font-bold text-ink">Publish {count} draft{count === 1 ? "" : "s"}?</h3>
        <p className="mt-2 text-body text-ink-secondary">Publishing makes these sessions bookable. Nothing changes on screen until the server confirms — there is no optimistic flip.</p>
        {error && <p role="alert" className="mt-3 text-body text-danger-on-tint">The server didn&apos;t confirm. No session was published.</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={actions.publish.pending}>Cancel</Button>
          <Button
            disabled={actions.publish.pending || count === 0}
            onClick={() => {
              setError(false);
              actions.publish.mutate({ session_ids: draftIds }, { onSuccess: onClose, onError: () => setError(true) });
            }}
          >
            {actions.publish.pending ? "Publishing…" : `Publish ${count} draft${count === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SessionsSection({ data, actions }: { data: SchedulingOverview; actions: SchedulingActions }) {
  const [publishing, setPublishing] = useState(false);
  const [creating, setCreating] = useState(false);
  const templateNames = useMemo(() => new Map(data.offering_templates.map((template) => [template.id, template.name])), [data.offering_templates]);
  const resourceNames = useMemo(() => new Map(data.resources.map((resource) => [resource.id, resource.name])), [data.resources]);
  const today = studioDate(new Date(), data.timezone);
  const columns = weekColumns(today);
  const draftIds = data.sessions.filter((session) => session.status === "draft").map((session) => session.id);
  const byDay = useMemo(() => {
    const map = new Map<string, ScheduledSessionRow[]>();
    for (const session of data.sessions) {
      const day = studioDate(session.starts_at, data.timezone);
      const list = map.get(day) ?? [];
      list.push(session);
      map.set(day, list);
    }
    for (const list of map.values()) list.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    return map;
  }, [data.sessions, data.timezone]);

  return (
    <Section
      title="Sessions this week"
      description={`Draft sessions are private until published. Times shown in ${data.timezone}.`}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setCreating((value) => !value)}>{creating ? "Close form" : "New session"}</Button>
          <Button disabled={draftIds.length === 0} onClick={() => setPublishing(true)}>Publish {draftIds.length} draft{draftIds.length === 1 ? "" : "s"}</Button>
        </div>
      }
    >
      {creating && <div className="mb-4"><CreateSessionForm data={data} actions={actions} /></div>}
      <div className="overflow-x-auto">
        <div className="grid min-w-full gap-2 md:grid-cols-7">
          {columns.map((day) => {
            const sessions = byDay.get(day) ?? [];
            const isToday = day === today;
            return (
              <div key={day} className={`rounded-2 border p-2 ${isToday ? "border-selected-border bg-selected-bg" : "border-hairline bg-surface-app"}`}>
                <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">{humanWeekday(day)}{isToday && <span className="ml-1 text-ink-secondary">· today</span>}</p>
                {sessions.length === 0 ? (
                  <p className="mt-2 text-chrome text-ink-muted">No sessions</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {sessions.map((session) => (
                      <li key={session.id} className="rounded-2 border border-hairline bg-surface-card p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-table font-medium text-ink">{studioClock(session.starts_at, data.timezone)}</span>
                          <SessionStatusBadge status={session.status} />
                        </div>
                        <p className="mt-1 text-body text-ink">{templateNames.get(session.offering_template_id) ?? "Unknown template"}</p>
                        <p className="text-chrome text-ink-muted">{resourceNames.get(session.resource_id) ?? "Unknown resource"} · {session.capacity} cap</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {publishing && <PublishDialog draftIds={draftIds} actions={actions} onClose={() => setPublishing(false)} />}
    </Section>
  );
}

function AuthoringBody({ data, actions }: { data: SchedulingOverview; actions: SchedulingActions }) {
  return (
    <div className="space-y-6">
      <SessionsSection data={data} actions={actions} />
      <ResourcesSection data={data} actions={actions} />
      <TemplatesSection data={data} actions={actions} />
    </div>
  );
}

function AuthoringView({ query, actions }: { query: BoundaryQuery; actions: SchedulingActions }) {
  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Schedule authoring · owner &amp; manager</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight">Author the schedule</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">Define resources and offering templates, then draft and publish sessions. Publishing is confirmed by the server — no session goes live until it acknowledges.</p>
      </header>
      <DataBoundary<SchedulingOverview>
        name="scheduling-overview"
        query={query}
        skeleton={<Skeleton className="h-96 w-full rounded-3" />}
        errorConsequence="The authoring workspace didn't load; no resource, template, or session was changed."
      >
        {(data) => <AuthoringBody data={data} actions={actions} />}
      </DataBoundary>
    </div>
  );
}

// -- Screen shell (tab toggle) -----------------------------------------------

type ScheduleTab = "heatmap" | "authoring";

const TAB_BASE = "h-11 rounded-2 px-4 text-body font-medium focus:outline-none focus:ring-2 focus:ring-brand-600";
const TAB_ACTIVE = "bg-selected-bg text-ink";
const TAB_INACTIVE = "text-ink-secondary";

export interface ScheduleScreenProps {
  /** The 2.6 fill-heatmap boundary query (unchanged). */
  query: BoundaryQuery;
  /** owner/manager gate — the Authoring tab is hidden entirely when false. */
  canAuthor?: boolean;
  /** GET /scheduling/overview boundary query (required to show Authoring). */
  overviewQuery?: BoundaryQuery;
  /** The eight authoring mutations (required to show Authoring). */
  actions?: SchedulingActions;
}

export function ScheduleScreen({ query, canAuthor = false, overviewQuery, actions }: ScheduleScreenProps) {
  const showAuthoring = canAuthor && overviewQuery !== undefined && actions !== undefined;
  const [tab, setTab] = useState<ScheduleTab>("heatmap");
  const active: ScheduleTab = showAuthoring ? tab : "heatmap";

  return (
    <div className="space-y-6">
      {showAuthoring && (
        <div role="tablist" aria-label="Schedule views" className="inline-flex gap-1 rounded-2 border border-hairline bg-surface-card p-1">
          <button type="button" role="tab" id="schedule-tab-heatmap" aria-selected={active === "heatmap"} aria-controls="schedule-panel" onClick={() => setTab("heatmap")} className={`${TAB_BASE} ${active === "heatmap" ? TAB_ACTIVE : TAB_INACTIVE}`}>Heatmap</button>
          <button type="button" role="tab" id="schedule-tab-authoring" aria-selected={active === "authoring"} aria-controls="schedule-panel" onClick={() => setTab("authoring")} className={`${TAB_BASE} ${active === "authoring" ? TAB_ACTIVE : TAB_INACTIVE}`}>Authoring</button>
        </div>
      )}
      <div id="schedule-panel" role={showAuthoring ? "tabpanel" : undefined} aria-labelledby={showAuthoring ? `schedule-tab-${active}` : undefined}>
        {active === "authoring" && showAuthoring ? <AuthoringView query={overviewQuery} actions={actions} /> : <HeatmapView query={query} />}
      </div>
    </div>
  );
}
