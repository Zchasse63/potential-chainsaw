import { useRef, useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { Skeleton } from "@kelo/ui/react";
import { SourceLabel } from "@kelo/ui/react";
import { StatusPill } from "@kelo/ui/react";
import { StepUpPrompt, type StepUpGrantResult } from "../components/step-up-prompt.jsx";
import {
  AUTHORITY_FLIP_STEP_UP_CONTEXT,
  GATE_LABELS,
  type AuthorityDomain,
  type AuthorityMatrix,
  type AuthorityMatrixRow,
  type FlipAccepted,
  type FlipInput,
  type GateAck,
  type GateKey,
  type ReadinessGate,
  type ReadinessReport,
  type ReadinessStage,
} from "../lib/setup.js";
import type { StaffRole } from "../lib/waivers.js";

/**
 * Setup — the launch-readiness + authority-matrix surface (Phase 7 · unit
 * 7.1c; UX §G "Assisted onboarding"). A presentational screen: every query and
 * mutation is injected so it is unit-testable without a network.
 *
 * Two regions, both provenance-bound:
 *   LAUNCH READINESS — the five UX §G stages with their server-computed gates.
 *     Stage completion and the ready-to-launch verdict are READ from the
 *     server's gates/stages, never recomputed from policy client-side.
 *     Acknowledge ≠ resolve (UX §F): acknowledging a soft warn gate attaches
 *     an audit note; the gate keeps rendering as a warn.
 *   AUTHORITY MATRIX — the 8 capability domains and who holds authority
 *     (glofox | kelo). A flip is OWNER-only, demands a typed reason + the
 *     owner step-up ceremony (the same StepUpPrompt the refund flow uses),
 *     and there is NO optimistic update — after a confirmed flip the matrix
 *     is re-read from the server and only server-confirmed state renders.
 */

export interface SetupScreenProps {
  /** The actor's most-privileged membership role (from /auth/me). Undefined
   *  while it loads — mutation affordances stay hidden (the API gates anyway). */
  role: StaffRole | undefined;
  readinessQuery: BoundaryQuery;
  authorityQuery: BoundaryQuery;
  onAcknowledge: (gateKey: GateKey, note: string, idempotencyKey: string) => Promise<GateAck>;
  onFlip: (input: FlipInput, grantToken: string, idempotencyKey: string) => Promise<FlipAccepted>;
  onVerifyStepUp: (pin: string, context: string) => Promise<StepUpGrantResult>;
}

const INPUT_CLASS =
  "h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";
const LABEL_CLASS = "block text-body font-medium text-ink";
const FIELD_HINT = "font-mono text-micro uppercase tracking-wide text-ink-muted";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key.replaceAll("_", " ")} ${value}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Launch readiness
// ---------------------------------------------------------------------------

/** The acknowledge form for a SOFT warn gate (owner only). One idempotency
 *  key per ack intent — minted on the first post, reused across retries,
 *  rotated on the server-confirmed acknowledgement. */
function AckForm({
  gateKey,
  onAcknowledge,
}: {
  gateKey: GateKey;
  onAcknowledge: (gateKey: GateKey, note: string, idempotencyKey: string) => Promise<GateAck>;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<GateAck | null>(null);
  const intentKey = useRef<string | null>(null);

  const valid = note.trim() !== "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending) return;
    if (intentKey.current === null) intentKey.current = crypto.randomUUID();
    setPending(true);
    setError(null);
    try {
      const ack = await onAcknowledge(gateKey, note.trim(), intentKey.current);
      // Server-confirmed: rotate the key and show the returned note. The gate
      // itself stays a warn — acknowledge is not resolve.
      intentKey.current = null;
      setRecorded(ack);
      setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The acknowledgement wasn't recorded.");
    } finally {
      setPending(false);
    }
  }

  if (recorded !== null) {
    return (
      <p role="status" data-testid={`ack-recorded-${gateKey}`} className="mt-2 text-body text-info-on-tint">
        Acknowledgement recorded — the gate stays a warning until the underlying issue is resolved.
      </p>
    );
  }

  return (
    <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => void submit(event)}>
      <div className="min-w-56 flex-1">
        <label className={LABEL_CLASS} htmlFor={`ack-note-${gateKey}`}>
          Acknowledge with note
        </label>
        <input
          id={`ack-note-${gateKey}`}
          className={INPUT_CLASS}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why proceeding despite this warning is acceptable"
        />
      </div>
      <Button type="submit" disabled={!valid || pending}>
        {pending ? "Recording…" : "Acknowledge"}
      </Button>
      {error !== null && (
        <p role="alert" className="w-full text-body text-danger-on-tint">
          {error}
        </p>
      )}
    </form>
  );
}

function GateRow({
  gate,
  isOwner,
  onAcknowledge,
}: {
  gate: ReadinessGate;
  isOwner: boolean;
  onAcknowledge: SetupScreenProps["onAcknowledge"];
}) {
  // Only SOFT warn gates are acknowledgeable: the ack endpoint 422s hard
  // gates (they must be RESOLVED, not waved through). The server also 422s
  // acks from non-owners, so the affordance is owner-only.
  const acknowledgeable = gate.status === "warn" && !gate.hard && isOwner;
  return (
    <li data-testid={`gate-${gate.key}`} className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={gate.status} />
        <span className="text-body font-medium text-ink">{GATE_LABELS[gate.key]}</span>
        {gate.hard && <span className={FIELD_HINT}>Hard gate</span>}
      </div>
      {gate.evidence.detail !== null && (
        <p className="mt-1 text-body text-ink-secondary">{gate.evidence.detail}</p>
      )}
      <p className={`mt-1 ${FIELD_HINT}`}>
        {formatCounts(gate.evidence.counts)}
        {/* FreshnessChip is not used per gate: the API owns the freshness-bucket
            thresholds and does not bucket per-gate evidence, so the as_of
            renders as plain provenance text (design guide §4). */}
        {gate.evidence.as_of !== null && ` · evidence as of ${formatDateTime(gate.evidence.as_of)}`}
      </p>
      {gate.acknowledged !== null && (
        <p
          data-testid={`ack-${gate.key}`}
          className="mt-2 rounded-2 border border-info-border bg-info-tint px-3 py-2 text-body text-info-on-tint"
        >
          Acknowledged {formatDateTime(gate.acknowledged.at)} — {gate.acknowledged.note}
        </p>
      )}
      {acknowledgeable && gate.acknowledged === null && (
        <AckForm gateKey={gate.key} onAcknowledge={onAcknowledge} />
      )}
    </li>
  );
}

function StageCard({
  stage,
  gates,
  isOwner,
  onAcknowledge,
}: {
  stage: ReadinessStage;
  gates: ReadinessGate[];
  isOwner: boolean;
  onAcknowledge: SetupScreenProps["onAcknowledge"];
}) {
  return (
    <section
      data-testid={`stage-${stage.key}`}
      className="rounded-3 border border-hairline bg-surface-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline p-3">
        <h3 className="text-body font-semibold text-ink">{stage.label}</h3>
        {/* Stage completion is the SERVER's word (stage.complete), never a
            client-side recomputation. */}
        <StatusPill status={stage.complete ? "pass" : "fail"} />
      </header>
      <ul className="divide-y divide-hairline">
        {gates.map((gate) => (
          <GateRow key={gate.key} gate={gate} isOwner={isOwner} onAcknowledge={onAcknowledge} />
        ))}
      </ul>
    </section>
  );
}

function LaunchReadiness({
  readinessQuery,
  role,
  onAcknowledge,
}: {
  readinessQuery: BoundaryQuery;
  role: StaffRole | undefined;
  onAcknowledge: SetupScreenProps["onAcknowledge"];
}) {
  return (
    <DataBoundary<ReadinessReport>
      name="launch-readiness"
      query={readinessQuery}
      skeleton={<Skeleton className="h-96 w-full rounded-3" />}
      errorConsequence="The launch-readiness checklist didn't load; nothing was changed."
    >
      {(data, meta) => {
        const gatesByKey = new Map(data.gates.map((gate) => [gate.key, gate]));
        // The launch verdict reads the SERVER-OWNED completion, never a
        // client re-derivation of the blocking policy: a stage is complete
        // iff none of its gates is blocking (readiness.ts owns that rule via
        // stage.complete). Recomputing "hard && fail" here would duplicate a
        // policy the server owns and silently drift the day the server's
        // hard/soft classification changes (a soft gate that starts failing
        // would keep a false green). Every stage complete ⇒ ready to launch.
        const ready = data.stages.every((stage) => stage.complete);
        // The gates the SERVER treats as blocking are exactly those in 'fail'
        // (readiness.ts isBlocking) — named here only to explain the verdict,
        // not to compute it.
        const blocking = data.gates.filter((gate) => gate.status === "fail");
        return (
          <section aria-label="Launch readiness" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-title font-bold text-ink">Launch readiness</h2>
              {/* SourceLabel covers native|glofox; readiness is a MIXED
                  envelope (Kelo + Glofox + Stripe), so its provenance is a
                  plain-language line per design guide §4 — no new component. */}
              <span className="text-chrome text-ink-muted">
                Combined from Kelo, Glofox &amp; Stripe · as of {formatDateTime(meta.as_of)}
              </span>
            </div>

            {ready ? (
              <div
                role="status"
                data-testid="launch-verdict"
                className="rounded-3 border border-success-border bg-success-tint p-4"
              >
                <p className="text-body font-medium text-success-on-tint">
                  Ready to launch — every hard launch gate passes.
                </p>
                <p className="mt-1 text-body text-success-on-tint">
                  Warnings below are non-blocking; acknowledge the soft ones with a note for the
                  audit trail.
                </p>
              </div>
            ) : (
              <div
                role="alert"
                data-testid="launch-verdict"
                className="rounded-3 border border-danger-border bg-danger-tint p-4"
              >
                <p className="text-body font-medium text-danger-on-tint">
                  Not ready to launch — {blocking.length} {blocking.length === 1 ? "gate" : "gates"}{" "}
                  failing: {blocking.map((gate) => GATE_LABELS[gate.key]).join(", ")}.
                </p>
                <p className="mt-1 text-body text-danger-on-tint">
                  Failing gates must be resolved, not acknowledged.
                </p>
              </div>
            )}

            <ol className="space-y-4">
              {data.stages.map((stage) => (
                <li key={stage.key}>
                  <StageCard
                    stage={stage}
                    gates={stage.gate_keys
                      .map((key) => gatesByKey.get(key))
                      .filter((gate): gate is ReadinessGate => gate !== undefined)}
                    isOwner={role === "owner"}
                    onAcknowledge={onAcknowledge}
                  />
                </li>
              ))}
            </ol>
          </section>
        );
      }}
    </DataBoundary>
  );
}

// ---------------------------------------------------------------------------
// Authority matrix
// ---------------------------------------------------------------------------

/** The flip form + the OWNER step-up ceremony gate (mirrors the payments
 *  RefundPanel). A flip ALWAYS steps up — it re-homes a whole capability
 *  domain. One idempotency key per flip intent; NO optimistic update: on the
 *  server-confirmed 201 the route invalidates and the matrix re-reads. */
function FlipPanel({
  row,
  onFlip,
  onVerifyStepUp,
  onDone,
}: {
  row: AuthorityMatrixRow;
  onFlip: SetupScreenProps["onFlip"];
  onVerifyStepUp: SetupScreenProps["onVerifyStepUp"];
  onDone: () => void;
}) {
  const target = row.authority === "glofox" ? "kelo" : "glofox";
  const [reason, setReason] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<FlipAccepted | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const intentKey = useRef<string | null>(null);

  const valid = reason.trim() !== "";

  async function post(grantToken: string) {
    if (intentKey.current === null) intentKey.current = crypto.randomUUID();
    setPending(true);
    setError(null);
    try {
      const flip = await onFlip(
        {
          domain: row.domain,
          authority: target,
          reason: reason.trim(),
          evidenceUrl: evidenceUrl.trim() === "" ? undefined : evidenceUrl.trim(),
        },
        grantToken,
        intentKey.current,
      );
      // Server-confirmed flip — rotate the key. The ROW does not change here;
      // the re-fetched matrix renders the new authority.
      intentKey.current = null;
      setAccepted(flip);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The flip wasn't accepted.");
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending) return;
    setStepUpOpen(true);
  }

  if (accepted !== null) {
    return (
      <div
        role="status"
        data-testid={`flip-confirmed-${row.domain}`}
        className="mt-3 rounded-2 border border-info-border bg-info-tint p-3"
      >
        <p className="text-body text-info-on-tint">
          Flip to {accepted.authority} confirmed by the server — the matrix above re-reads from the
          server, so the row updates once the confirmed state lands.
        </p>
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" className="h-9" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="mt-3 grid gap-3 rounded-2 border border-hairline bg-surface-app p-3"
      onSubmit={submit}
    >
      <p className={FIELD_HINT}>Flip {row.domain} authority to {target} · owner step-up required</p>
      <div>
        <label className={LABEL_CLASS} htmlFor={`flip-reason-${row.domain}`}>
          Reason <span className={FIELD_HINT}>required — written to the audit ledger</span>
        </label>
        <input
          id={`flip-reason-${row.domain}`}
          className={INPUT_CLASS}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this domain changes authority now"
        />
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor={`flip-evidence-${row.domain}`}>
          Evidence URL <span className={FIELD_HINT}>optional</span>
        </label>
        <input
          id={`flip-evidence-${row.domain}`}
          className={INPUT_CLASS}
          value={evidenceUrl}
          onChange={(event) => setEvidenceUrl(event.target.value)}
          placeholder="https://…"
        />
      </div>
      {error !== null && (
        <p role="alert" className="text-body text-danger-on-tint">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || pending}>
          {pending ? "Flipping…" : `Flip to ${target === "kelo" ? "Kelo" : "Glofox"}`}
        </Button>
      </div>

      <StepUpPrompt
        open={stepUpOpen}
        context={AUTHORITY_FLIP_STEP_UP_CONTEXT}
        title="Owner approval for authority flip"
        onVerify={onVerifyStepUp}
        onGranted={(grant) => {
          setStepUpOpen(false);
          void post(grant.grantToken);
        }}
        onClose={() => setStepUpOpen(false)}
      />
    </form>
  );
}

function AuthorityMatrixSection({
  authorityQuery,
  role,
  onFlip,
  onVerifyStepUp,
}: {
  authorityQuery: BoundaryQuery;
  role: StaffRole | undefined;
  onFlip: SetupScreenProps["onFlip"];
  onVerifyStepUp: SetupScreenProps["onVerifyStepUp"];
}) {
  const [openDomain, setOpenDomain] = useState<AuthorityDomain | null>(null);

  return (
    <DataBoundary<AuthorityMatrix>
      name="authority-matrix"
      query={authorityQuery}
      skeleton={<Skeleton className="h-64 w-full rounded-3" />}
      errorConsequence="The authority matrix didn't load; no flip was attempted."
    >
      {(data, meta) => (
        <section aria-label="Authority matrix" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-title font-bold text-ink">Authority matrix</h2>
            <SourceLabel source={meta.source === "native" ? "native" : "glofox"} />
          </div>
          <p className="max-w-2xl text-body text-ink-secondary">
            Which system is the source of truth for each capability domain. Flipping re-homes the
            domain — owner-only, reason + step-up required, and the change renders only after the
            server confirms it.
          </p>
          <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
            {data.matrix.map((row) => {
              const target = row.authority === "glofox" ? "kelo" : "glofox";
              return (
                <li key={row.domain} data-testid={`authority-row-${row.domain}`} className="p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-medium capitalize text-ink">{row.domain}</span>
                      <span className={FIELD_HINT} data-testid={`authority-current-${row.domain}`}>
                        {row.authority}
                      </span>
                      <SourceLabel source={row.authority === "kelo" ? "native" : "glofox"} />
                    </div>
                    {role === "owner" && openDomain !== row.domain && (
                      <Button
                        variant="ghost"
                        className="h-9"
                        onClick={() => setOpenDomain(row.domain)}
                      >
                        Flip to {target === "kelo" ? "Kelo" : "Glofox"}
                      </Button>
                    )}
                  </div>
                  {row.flipped_at !== null && (
                    <p className={`mt-1 ${FIELD_HINT}`}>
                      Flipped {formatDateTime(row.flipped_at)}
                      {row.reason !== null && ` — ${row.reason}`}
                    </p>
                  )}
                  {role === "owner" && openDomain === row.domain && (
                    <FlipPanel
                      // Remount per domain so a half-typed reason or a
                      // per-intent idempotency key never bleeds across domains.
                      key={row.domain}
                      row={row}
                      onFlip={onFlip}
                      onVerifyStepUp={onVerifyStepUp}
                      onDone={() => setOpenDomain(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {role === "manager" && (
            <p className="text-body text-ink-muted">
              The matrix is read-only for managers — only an owner can flip a domain&apos;s
              authority.
            </p>
          )}
        </section>
      )}
    </DataBoundary>
  );
}

export function SetupScreen({
  role,
  readinessQuery,
  authorityQuery,
  onAcknowledge,
  onFlip,
  onVerifyStepUp,
}: SetupScreenProps) {
  return (
    <div className="space-y-10">
      <header>
        <p className={FIELD_HINT}>Setup · launch readiness &amp; cutover</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Setup</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          The launch checklist is computed from real data, not self-report — a stage completes only
          when its gates say so, and hard gates must be resolved before launch.
        </p>
      </header>

      <LaunchReadiness readinessQuery={readinessQuery} role={role} onAcknowledge={onAcknowledge} />
      <AuthorityMatrixSection
        authorityQuery={authorityQuery}
        role={role}
        onFlip={onFlip}
        onVerifyStepUp={onVerifyStepUp}
      />
    </div>
  );
}
