/**
 * Freshness buckets — mirrors apps/api/src/freshness.ts. The API owns the
 * thresholds (live <1m, synced ≥1m, stale ≥2h, critical ≥4h, null → unknown)
 * and computes the bucket; the web app only renders what it is given.
 */
export type FreshnessBucket = "live" | "synced" | "stale" | "critical" | "unknown";
