import type { FreshnessBucket } from "../lib/freshness.js";

/**
 * FreshnessChip — design guide §4 verbatim:
 *   live     → "● LIVE"          success dot, hairline border (healthy)
 *   synced   → "● SYNCED {n}M"   dot neutral-400, TEXT neutral-600 — the
 *                                freshness-aged split; neutral-400 is NEVER
 *                                text (amendment: the ink floor is n600)
 *   stale    → "● STALE {n}H"    amber tint (≥2h)
 *   critical → "■ STALE 4H+"     red tint, dot becomes a SQUARE, weight 600 (≥4h)
 *   unknown  → "○ NO DATA"       neutral honest state (never synced)
 * Micro mono, full-radius chip. The marker SHAPE and the label TEXT both carry
 * the state — never color alone.
 */

type MarkerShape = "circle" | "square" | "ring";

function Marker({ shape, className }: { shape: MarkerShape; className?: string }) {
  if (shape === "ring") {
    return (
      <span
        aria-hidden="true"
        data-marker="ring"
        className="h-1.5 w-1.5 rounded-full border border-neutral-400"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-marker={shape}
      className={`h-1.5 w-1.5 ${shape === "square" ? "rounded-critical-dot" : "rounded-full"} ${className ?? ""}`}
    />
  );
}

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-micro tracking-wide";

function staleLabel(minutesStale: number | null): string {
  // The API only assigns "stale" at ≥120 minutes; the floor guards a
  // contradictory payload rather than letting it render "STALE 0H".
  const hours = Math.floor((minutesStale ?? 120) / 60);
  return `STALE ${Math.max(2, hours)}H`;
}

export function FreshnessChip({
  bucket,
  minutesStale,
}: {
  bucket: FreshnessBucket;
  minutesStale: number | null;
}) {
  switch (bucket) {
    case "live":
      return (
        <span
          data-testid="freshness-chip"
          className={`${CHIP_BASE} border-hairline bg-surface-card text-success-on-tint`}
        >
          <Marker shape="circle" className="bg-success" />
          LIVE
        </span>
      );
    case "synced":
      return (
        <span
          data-testid="freshness-chip"
          className={`${CHIP_BASE} border-hairline bg-surface-card text-ink-muted`}
        >
          <Marker shape="circle" className="bg-neutral-400" />
          {minutesStale === null ? "SYNCED" : `SYNCED ${minutesStale}M`}
        </span>
      );
    case "stale":
      return (
        <span
          data-testid="freshness-chip"
          className={`${CHIP_BASE} border-warning-border bg-warning-tint text-warning-on-tint`}
        >
          <Marker shape="circle" className="bg-warning" />
          {staleLabel(minutesStale)}
        </span>
      );
    case "critical":
      return (
        <span
          data-testid="freshness-chip"
          className={`${CHIP_BASE} border-danger-border bg-danger-tint font-semibold text-danger-on-tint`}
        >
          <Marker shape="square" className="bg-danger" />
          STALE 4H+
        </span>
      );
    case "unknown":
      return (
        <span
          data-testid="freshness-chip"
          className={`${CHIP_BASE} border-hairline bg-surface-card text-ink-muted`}
        >
          <Marker shape="ring" />
          NO DATA
        </span>
      );
  }
}
