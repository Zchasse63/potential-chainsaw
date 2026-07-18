import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "./button.jsx";
import { EmptyState } from "./empty-state.jsx";
import type { BriefingArtifact, FeedbackInput, FeedbackMutationHandle } from "../lib/today.js";

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleCaseKey(key: string): string {
  return key.replaceAll("_", " ");
}

export type RenderableBriefingArtifact = Pick<
  BriefingArtifact,
  "id" | "generated_for" | "status" | "output"
> &
  Partial<Pick<BriefingArtifact, "input" | "error">>;

interface Candidate {
  id: string;
  category?: string;
  headline_facts?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

interface GeneratedInsight extends Candidate {
  headline?: string;
  why?: string;
  action?: string;
}

function candidatesFrom(artifact: RenderableBriefingArtifact): Candidate[] {
  if (!isRecord(artifact.input)) return [];
  const raw = Array.isArray(artifact.input["selected"])
    ? artifact.input["selected"]
    : Array.isArray(artifact.input["candidates"])
      ? artifact.input["candidates"]
      : [];
  return raw.filter(isRecord).flatMap((candidate) =>
    typeof candidate["id"] === "string" ? [candidate as unknown as Candidate] : [],
  );
}

function insightsFrom(artifact: RenderableBriefingArtifact): GeneratedInsight[] {
  if (!isRecord(artifact.output) || !Array.isArray(artifact.output["insights"])) return [];
  return artifact.output["insights"].filter(isRecord).flatMap((insight) =>
    typeof insight["id"] === "string" ? [insight as unknown as GeneratedInsight] : [],
  );
}

function formatFact(key: string, value: number): string {
  const normalized = key.toLowerCase();
  if (normalized.includes("mrr") || normalized.includes("sum") || normalized.includes("net") || normalized.includes("liability")) return MONEY.format(value);
  if (normalized.includes("percent") || normalized.includes("rate")) return `${NUMBER.format(value)}%`;
  return NUMBER.format(value);
}

function evidenceFacts(candidate: Candidate | GeneratedInsight): Array<{ key: string; value: string }> {
  const headline = isRecord(candidate.headline_facts) ? candidate.headline_facts : {};
  const facts = Object.entries(headline).flatMap(([key, value]) =>
    typeof value === "number" && Number.isFinite(value)
      ? [{ key: titleCaseKey(key), value: formatFact(key, value) }]
      : [],
  );
  const evidence = isRecord(candidate.evidence) ? candidate.evidence : {};
  const segments = evidence["segment_keys"];
  if (Array.isArray(segments)) {
    const safe = segments.filter((value): value is string => typeof value === "string");
    if (safe.length > 0) facts.push({ key: "segments", value: safe.map(titleCaseKey).join(", ") });
  }
  return facts;
}

function EvidenceChips({ facts, ai }: { facts: Array<{ key: string; value: string }>; ai: boolean }) {
  if (facts.length === 0) return <p className="text-chrome text-ink-muted">No candidate facts were returned.</p>;
  return (
    <ul aria-label="Evidence" className="flex flex-wrap gap-2">
      {facts.map((fact) => (
        <li key={`${fact.key}:${fact.value}`} className={`rounded-full border px-2 py-1 font-mono text-micro uppercase tracking-wide text-ink-secondary ${ai ? "border-ai-border-tint bg-ai-tint" : "border-hairline bg-surface-app"}`}>
          {fact.key} · {fact.value}
        </li>
      ))}
    </ul>
  );
}

function FeedbackControls({ artifactId, itemRef, feedback }: { artifactId: string; itemRef: string; feedback: FeedbackMutationHandle }) {
  const [pending, setPending] = useState<FeedbackInput["verdict"] | null>(null);
  const [sent, setSent] = useState<FeedbackInput["verdict"] | null>(null);
  const [failed, setFailed] = useState(false);
  const vote = (verdict: FeedbackInput["verdict"]) => {
    setPending(verdict);
    setFailed(false);
    feedback.mutate(
      { artifact_id: artifactId, item_ref: itemRef, verdict },
      {
        onSuccess: () => { setPending(null); setSent(verdict); },
        onError: () => { setPending(null); setFailed(true); },
      },
    );
  };
  if (sent !== null) return <p role="status" className="text-chrome text-ai-on-tint">✓ Feedback sent: {sent === "up" ? "Helpful" : "Not helpful"}</p>;
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-chrome text-ink-muted">Was this useful?</span>
        <Button variant="ghost" className="h-11 px-3" aria-label={`Helpful: ${itemRef}`} disabled={pending !== null} onClick={() => vote("up")}>👍</Button>
        <Button variant="ghost" className="h-11 px-3" aria-label={`Not helpful: ${itemRef}`} disabled={pending !== null} onClick={() => vote("down")}>👎</Button>
        {pending !== null && <span className="text-chrome text-ink-muted">Sending…</span>}
      </div>
      {failed && <p role="alert" className="text-chrome text-danger-on-tint">Feedback wasn&apos;t sent. The briefing is still available to read.</p>}
    </div>
  );
}

function AiInsightCard({ insight, candidate, artifactId, feedback }: { insight: GeneratedInsight; candidate: Candidate | undefined; artifactId: string; feedback?: FeedbackMutationHandle }) {
  return (
    <article className="rounded-3 border border-dotted border-ai-accent bg-ai-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-ai-on-tint">Kelo Intelligence</p>
      <h3 className="mt-2 font-display text-title font-bold tracking-tight">{insight.headline ?? "Review this evidence"}</h3>
      <p className="mt-2 text-body text-ink-secondary">{insight.why ?? "The generated artifact did not include an explanation."}</p>
      <p className="mt-2 text-body font-medium text-ink">Action · {insight.action ?? "Review the cited facts."}</p>
      <div className="mt-3"><EvidenceChips facts={evidenceFacts(candidate ?? insight)} ai /></div>
      {feedback !== undefined && (
        <div className="mt-3 border-t border-ai-border-tint pt-3">
          <FeedbackControls artifactId={artifactId} itemRef={insight.id} feedback={feedback} />
        </div>
      )}
    </article>
  );
}

const FALLBACK_TITLES: Record<string, string> = {
  revenue: "Review the revenue change", payments: "Review outstanding payments",
  retention: "Review retention signals", conversion: "Review conversion opportunities",
  data_health: "Review data health",
};

function FallbackFactCard({ insight }: { insight: GeneratedInsight }) {
  return (
    <article className="rounded-3 border border-hairline bg-surface-card p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Generated without AI synthesis</p>
      <h3 className="mt-2 text-body font-medium text-ink">{FALLBACK_TITLES[insight.category ?? ""] ?? "Review today’s facts"}</h3>
      <div className="mt-3"><EvidenceChips facts={evidenceFacts(insight)} ai={false} /></div>
    </article>
  );
}

function RefusedBriefing({ artifact }: { artifact: RenderableBriefingArtifact }) {
  const output = isRecord(artifact.output) ? artifact.output : {};
  const health = isRecord(output["health"])
    ? output["health"]
    : isRecord(artifact.input) && isRecord(artifact.input["health"])
      ? artifact.input["health"]
      : {};
  const ids = Array.isArray(health["reconciliation_ids"])
    ? health["reconciliation_ids"].filter((id): id is string => typeof id === "string")
    : [];
  const syncEntities = Array.isArray(health["sync_entities"])
    ? health["sync_entities"].filter((entity): entity is string => typeof entity === "string")
    : [];
  const message = typeof output["message"] === "string" ? output["message"] : (artifact.error ?? "source data health is red");
  return (
    <div className="space-y-3">
      <div className="rounded-3 border border-danger-border bg-danger-tint p-4">
        <p className="text-body font-medium text-danger-on-tint">Briefing paused: {message}</p>
        {ids.length > 0 && <p className="mt-2 font-mono text-chrome text-danger-on-tint">Failed reconciliation {ids.length === 1 ? "check" : "checks"}: {ids.join(", ")}</p>}
        {syncEntities.length > 0 && <p className="mt-2 text-body text-danger-on-tint">Red sync {syncEntities.length === 1 ? "source" : "sources"}: {syncEntities.join(", ")}</p>}
        <Link to="/health" className="mt-3 inline-block font-medium text-link underline">Open Health</Link>
      </div>
      <p className="text-body text-ink-secondary">Metrics-only mode — briefing narration is paused; independently sourced KPIs remain available.</p>
    </div>
  );
}

export function BriefingStatusChip({ status, yesterday = false }: { status: BriefingArtifact["status"] | "absent"; yesterday?: boolean }) {
  const config = yesterday
    ? { marker: "▲", label: "Yesterday", classes: "border-warning-border bg-warning-tint text-warning-on-tint" }
    : status === "generated"
      ? { marker: "✓", label: "Generated", classes: "border-success-border bg-success-tint text-success-on-tint" }
      : status === "fallback"
        ? { marker: "○", label: "Without AI", classes: "border-info-border bg-info-tint text-info-on-tint" }
        : status === "refused"
          ? { marker: "■", label: "Paused", classes: "border-danger-border bg-danger-tint text-danger-on-tint" }
          : { marker: "○", label: "Not generated", classes: "border-hairline bg-surface-card text-ink-muted" };
  return <span data-testid="briefing-status" className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${config.classes}`}><span aria-hidden="true">{config.marker}</span>{config.label}</span>;
}

export function BriefingArtifactView({ artifact, yesterday = false, feedback }: { artifact: RenderableBriefingArtifact; yesterday?: boolean; feedback?: FeedbackMutationHandle }) {
  if (artifact.status === "refused") return <RefusedBriefing artifact={artifact} />;
  const insights = insightsFrom(artifact);
  if (insights.length === 0) return <EmptyState title="No urgent actions today." body="The briefing completed and found no candidate facts above the action threshold." />;
  const candidates = candidatesFrom(artifact);
  return (
    <div className="space-y-3">
      {yesterday && <div role="status" className="rounded-2 border border-warning-border bg-warning-tint px-4 py-3"><p className="font-mono text-body font-bold uppercase tracking-wide text-warning-emphasis">Yesterday&apos;s briefing</p><p className="mt-1 text-body text-warning-on-tint">Today&apos;s briefing is not ready, so these are yesterday&apos;s facts.</p></div>}
      {artifact.status === "generated"
        ? insights.map((insight) => <AiInsightCard key={insight.id} insight={insight} candidate={candidates.find((candidate) => candidate.id === insight.id)} artifactId={artifact.id} feedback={feedback} />)
        : insights.map((insight) => <FallbackFactCard key={insight.id} insight={insight} />)}
    </div>
  );
}
