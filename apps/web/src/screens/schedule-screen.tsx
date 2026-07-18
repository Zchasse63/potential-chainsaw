import { useMemo, useState } from "react";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { deviceTimeZone, formatTimestamp } from "../lib/time.js";
import type { HeatmapResponse } from "../lib/intelligence.js";

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

export function ScheduleScreen({ query }: { query: BoundaryQuery }) {
  return <div className="space-y-6"><header><p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Schedule tuning · phase 2 approximation</p><h1 className="mt-1 font-display text-hero font-bold tracking-tight">30-day fill heatmap</h1><p className="mt-2 max-w-2xl text-body text-ink-secondary">Cell tint is booked capacity ÷ imported session capacity. It is fill, not demand. Turnover and room-readiness modeling arrive in phase 4.</p></header><DataBoundary<HeatmapResponse> name="schedule-fill-heatmap" query={query} skeleton={<Skeleton className="h-96 w-full rounded-3" />} errorConsequence="The fill heatmap didn't load; no schedule data was changed.">{(data) => <Heatmap data={data} />}</DataBoundary></div>;
}
