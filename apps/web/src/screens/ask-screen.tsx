import { useState } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { inspectEnvelope } from "../lib/envelope.js";
import type {
  AskCatalogEntry,
  AskCatalogResponse,
  AskMutationHandle,
  AskResponse,
} from "../lib/intelligence.js";

function displayValue(value: unknown): string {
  if (value === null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ResultTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) return <p className="text-body text-ink-secondary">The approved query returned no matching rows.</p>;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="overflow-x-auto rounded-2 border border-hairline">
      <table className="min-w-full border-collapse text-left text-table">
        <thead className="bg-surface-app font-mono text-micro uppercase tracking-wide text-ink-muted">
          <tr>{columns.map((column) => <th key={column} className="border-b border-hairline px-3 py-2">{column.replaceAll("_", " ")}</th>)}</tr>
        </thead>
        <tbody>{rows.map((row, index) => <tr key={index} className="border-b border-hairline last:border-0">{columns.map((column) => <td key={column} className="px-3 py-2 font-mono text-ink-secondary">{displayValue(row[column])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function CatalogList({ catalog, onAsk, disabled }: { catalog: AskCatalogEntry[]; onAsk: (question: string) => void; disabled: boolean }) {
  return (
    <ul className="grid gap-2 md:grid-cols-2">
      {catalog.map((entry) => (
        <li key={entry.key}>
          <button type="button" disabled={disabled} onClick={() => onAsk(entry.title)} className="h-full w-full rounded-2 border border-hairline bg-surface-card p-3 text-left hover:bg-ghost-hover focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 disabled:text-ink-disabled">
            <span className="text-body font-medium text-ink">{entry.title}</span>
            <span className="mt-1 block text-chrome text-ink-muted">{entry.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AskScreen({ catalogQuery, ask }: { catalogQuery: BoundaryQuery; ask: AskMutationHandle }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState(false);
  const submit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    setError(false);
    ask.mutate(trimmed, {
      onSuccess: (raw) => {
        const inspected = inspectEnvelope<AskResponse>(raw);
        if (inspected.ok) setResult(inspected.data);
        else setError(true);
      },
      onError: () => setError(true),
    });
  };
  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Approved metric queries</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight">Ask Kelo</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">Ask about the catalog below. Kelo selects a tested query and typed parameters; it never writes SQL.</p>
      </header>
      <form className="rounded-3 border border-hairline bg-surface-card p-4" onSubmit={(event) => { event.preventDefault(); submit(question); }}>
        <label htmlFor="ask-question" className="text-body font-medium text-ink">What do you want to know?</label>
        <textarea id="ask-question" rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="For example: What is our current MRR?" className="mt-2 w-full rounded-2 border border-input-border bg-surface-input p-3 text-body text-ink placeholder:text-ink-placeholder focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600" />
        <div className="mt-3 flex justify-end"><Button type="submit" disabled={ask.pending || question.trim() === ""}>{ask.pending ? "Checking the catalog…" : "Ask this question"}</Button></div>
      </form>
      {error && <div role="alert" className="rounded-2 border border-danger-border bg-danger-tint p-3 text-body text-danger-on-tint">The question was not answered. No query result was changed; try again.</div>}
      {result !== null && (
        <section aria-labelledby="ask-answer" className="space-y-3">
          <h2 id="ask-answer" className="font-display text-title font-bold">Answer</h2>
          {result.answer.narration !== null && <div className="rounded-3 border border-dotted border-ai-accent bg-ai-surface p-4"><p className="font-mono text-micro uppercase tracking-wide text-ai-on-tint">Kelo Intelligence</p><p className="mt-2 text-body text-ink">{result.answer.narration}</p></div>}
          {result.answer.note !== undefined && <p className="text-chrome text-ink-muted">{result.answer.note}</p>}
          <ResultTable rows={result.answer.rows} />
          {result.answer.citation !== null && <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Catalog · {result.answer.citation.catalog_key} v{result.answer.citation.version} · Metrics · {result.answer.citation.metric_keys.length === 0 ? "operational source rows" : result.answer.citation.metric_keys.join(", ")}</p>}
        </section>
      )}
      <section aria-labelledby="ask-catalog" className="space-y-3">
        <h2 id="ask-catalog" className="font-display text-title font-bold">Questions Kelo can answer now</h2>
        <DataBoundary<AskCatalogResponse> name="ask-catalog" query={catalogQuery} skeleton={<Skeleton className="h-64 w-full rounded-3" />} errorConsequence="The approved question catalog didn't load, so no question can be safely executed.">
          {(data) => <CatalogList catalog={data.catalog} disabled={ask.pending} onAsk={(title) => { setQuestion(title); submit(title); }} />}
        </DataBoundary>
      </section>
    </div>
  );
}
