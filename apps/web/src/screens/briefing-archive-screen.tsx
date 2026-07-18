import { useState } from "react";
import { BriefingArtifactView, BriefingStatusChip } from "../components/briefing-artifact.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import type { BriefingArchiveArtifact, BriefingArchiveResponse } from "../lib/intelligence.js";

function Archive({ artifacts }: { artifacts: BriefingArchiveArtifact[] }) {
  const [selectedId, setSelectedId] = useState(artifacts[0]?.id ?? null);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
        {artifacts.map((artifact) => <li key={artifact.id}><button type="button" onClick={() => setSelectedId(artifact.id)} className={`w-full p-3 text-left hover:bg-ghost-hover focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-inset ${selected?.id === artifact.id ? "bg-selected-bg" : ""}`}><span className="block font-mono text-table text-ink">{artifact.generated_for}</span><span className="mt-2 block"><BriefingStatusChip status={artifact.status} /></span></button></li>)}
      </ul>
      {selected !== undefined && <section aria-labelledby="archive-artifact" className="lg:col-span-2"><h2 id="archive-artifact" className="mb-3 font-display text-title font-bold">Briefing for {selected.generated_for}</h2><BriefingArtifactView artifact={selected} /></section>}
    </div>
  );
}

export function BriefingArchiveScreen({ query }: { query: BoundaryQuery }) {
  return <div className="space-y-6"><header><p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Kelo Intelligence history</p><h1 className="mt-1 font-display text-hero font-bold tracking-tight">Briefing archive</h1></header><DataBoundary<BriefingArchiveResponse> name="briefing-archive" query={query} skeleton={<Skeleton className="h-80 w-full rounded-3" />} errorConsequence="Past briefings didn't load; today's briefing was not affected." isEmpty={(data) => data.artifacts.length === 0} emptyState={<EmptyState title="No past briefings yet." body="Generated, fallback, and refused artifacts will appear here." />}>{(data) => <Archive artifacts={data.artifacts} />}</DataBoundary></div>;
}
