import type { ReconciliationStatus } from "../lib/import.js";

/**
 * Reconciliation status pill — shape + icon + color, NEVER color alone
 * (design guide §4 grammar, the same rule the alert SeverityPill follows):
 *   match → ✓ success tint     (the two sources agree)
 *   drift → ▲ warning tint     (imported Glofox and native Kelo disagree)
 *   error → ✕ danger tint      (the check itself failed)
 * The marker glyph and the label text both carry the state.
 */
const PILL: Record<ReconciliationStatus, { marker: string; classes: string; label: string }> = {
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
};

export function StatusPill({ status }: { status: ReconciliationStatus }) {
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
