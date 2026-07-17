/**
 * Freshness buckets for /health (design-guide freshness-policy: live <1m,
 * SYNCED {n}M from 1m, amber "stale" ≥2h, red "critical" ≥4h; plan-final §4
 * "staleness banner ambers at 2h, reds at 4h").
 */

export type FreshnessBucket = "live" | "synced" | "stale" | "critical" | "unknown";

export const STALE_THRESHOLD_MINUTES = 120;
export const CRITICAL_THRESHOLD_MINUTES = 240;

/**
 * `null` minutes (never synced) maps to "unknown" — the design guide's
 * explicit unknown state, not a freshness verdict.
 */
export function freshnessBucket(minutesStale: number | null): FreshnessBucket {
  if (minutesStale === null) {
    return "unknown";
  }
  if (minutesStale < 1) {
    return "live";
  }
  if (minutesStale < STALE_THRESHOLD_MINUTES) {
    return "synced";
  }
  if (minutesStale < CRITICAL_THRESHOLD_MINUTES) {
    return "stale";
  }
  return "critical";
}

/** Whole minutes since an ISO timestamp; null when absent/unparseable. */
export function minutesSince(iso: string | null, nowMs: number): number | null {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - ms) / 60_000));
}
