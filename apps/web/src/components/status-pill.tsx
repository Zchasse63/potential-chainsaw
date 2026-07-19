import type { ReconciliationStatus } from "../lib/import.js";

/**
 * Status pill — shape + icon + color, NEVER color alone (design guide §4
 * grammar, the same rule the alert SeverityPill follows). Two domains share
 * the one component (one pattern per job):
 *   reconciliation: match → ✓ success · drift → ▲ warning · error → ✕ danger
 *   readiness gate: pass  → ✓ success · warn  → ▲ warning · fail  → ✕ danger
 * The marker glyph and the label text both carry the state.
 */
export type StatusPillStatus = ReconciliationStatus | "pass" | "warn" | "fail";

const PILL: Record<StatusPillStatus, { marker: string; classes: string; label: string }> = {
  match: {
    marker: "✓",
    classes: "border-success-border bg-success-tint text-success-on-tint",
    label: "Match",
  },
  drift: {
    marker: "▲",
    classes: "border-warning-border bg-warning-tint text-warning-on-tint",
    label: "Drift",
  },
  error: {
    marker: "✕",
    classes: "border-danger-border bg-danger-tint text-danger-on-tint",
    label: "Error",
  },
  pass: {
    marker: "✓",
    classes: "border-success-border bg-success-tint text-success-on-tint",
    label: "Pass",
  },
  warn: {
    marker: "▲",
    classes: "border-warning-border bg-warning-tint text-warning-on-tint",
    label: "Warn",
  },
  fail: {
    marker: "✕",
    classes: "border-danger-border bg-danger-tint text-danger-on-tint",
    label: "Fail",
  },
};

export function StatusPill({ status }: { status: StatusPillStatus }) {
  const pill = PILL[status];
  return (
    <span
      data-testid={`status-pill-${status}`}
      data-marker={pill.marker}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${pill.classes}`}
    >
      <span aria-hidden="true">{pill.marker}</span>
      {pill.label}
    </span>
  );
}
