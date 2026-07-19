import type { PaymentStatus, Tender } from "../lib/payments.js";

/**
 * Payment status + tender chips (design guide §4 grammar: shape/glyph + label
 * carry the state; NEVER color alone). The provenance distinction the money
 * surface must make visible is confirmation authority:
 *
 *   WEBHOOK-CONFIRMED (the signed Stripe webhook / inbox is the authority) —
 *     succeeded, refunded, partially_refunded, failed. A solid glyph + a
 *     "Confirmed" affordance mark that the state is real.
 *   PRE-CONFIRMATION (no optimistic UI may invent these) —
 *     requires_payment, processing. A hollow ◍/◌ glyph + "Awaiting provider"
 *     mark that the state is not yet authoritative.
 *
 * The glyph and the label both encode the state, so the chip reads without
 * color for the color-blind and in monochrome print.
 */

interface StatusPresentation {
  marker: string;
  label: string;
  provenance: string;
  confirmed: boolean;
  classes: string;
}

const STATUS: Record<PaymentStatus, StatusPresentation> = {
  succeeded: {
    marker: "●",
    label: "Succeeded",
    provenance: "Webhook-confirmed",
    confirmed: true,
    classes: "border-success-border bg-success-tint text-success-on-tint",
  },
  refunded: {
    marker: "●",
    label: "Refunded",
    provenance: "Webhook-confirmed",
    confirmed: true,
    classes: "border-neutral-300 bg-neutral-100 text-ink-secondary",
  },
  partially_refunded: {
    marker: "◐",
    label: "Partially refunded",
    provenance: "Webhook-confirmed",
    confirmed: true,
    classes: "border-neutral-300 bg-neutral-100 text-ink-secondary",
  },
  failed: {
    marker: "✕",
    label: "Failed",
    provenance: "Webhook-confirmed",
    confirmed: true,
    classes: "border-danger-border bg-danger-tint text-danger-on-tint",
  },
  requires_payment: {
    marker: "◌",
    label: "Requires payment",
    provenance: "Awaiting provider",
    confirmed: false,
    classes: "border-warning-border bg-warning-tint text-warning-on-tint",
  },
  processing: {
    marker: "◍",
    label: "Processing",
    provenance: "Awaiting provider",
    confirmed: false,
    classes: "border-info-border bg-info-tint text-info-on-tint",
  },
};

export function PaymentStatusChip({ status }: { status: PaymentStatus }) {
  const pill = STATUS[status];
  return (
    <span
      data-testid={`payment-status-${status}`}
      data-confirmed={pill.confirmed ? "true" : "false"}
      data-marker={pill.marker}
      title={pill.provenance}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-micro uppercase tracking-wide ${pill.classes}`}
    >
      <span aria-hidden="true">{pill.marker}</span>
      {pill.label}
      <span className="border-l border-current pl-1 opacity-80">{pill.provenance}</span>
    </span>
  );
}

const TENDER: Record<Tender, { marker: string; label: string }> = {
  cash: { marker: "◈", label: "Cash" },
  stripe: { marker: "▤", label: "Card" },
  gift_card: { marker: "◆", label: "Gift card" },
};

export function TenderBadge({ tender }: { tender: Tender }) {
  const badge = TENDER[tender];
  return (
    <span
      data-testid={`tender-${tender}`}
      data-marker={badge.marker}
      className="inline-flex items-center gap-1 rounded-2 border border-hairline bg-surface-app px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-ink-secondary"
    >
      <span aria-hidden="true">{badge.marker}</span>
      {badge.label}
    </span>
  );
}
