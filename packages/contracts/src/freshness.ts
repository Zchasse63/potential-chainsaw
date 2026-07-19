/**
 * Freshness buckets — the API owns the thresholds (live <1m, synced ≥1m,
 * stale ≥2h, critical ≥4h, null → unknown; apps/api/src/freshness.ts) and
 * computes the bucket; clients only render what they are given. Lives in
 * contracts (Wave 8.1b) so every client surface shares the one type.
 */
export type FreshnessBucket = "live" | "synced" | "stale" | "critical" | "unknown";
