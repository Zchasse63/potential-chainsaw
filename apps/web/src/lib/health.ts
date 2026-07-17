import { useQuery } from "@tanstack/react-query";
import { fetchEnvelope } from "./api.js";
import type { FreshnessBucket } from "./freshness.js";

/**
 * The /health response shape, mirrored from the API (the client-side
 * contract): apps/api/src/routes/health.ts assembles it from
 * apps/api/src/data.ts (sync_state / sync_runs / alerts row schemas) and
 * apps/api/src/authority.ts (AUTHORITY_MATRIX). Buckets come from
 * apps/api/src/freshness.ts — the server computes, the client renders.
 */

export type { FreshnessBucket } from "./freshness.js";

export type SyncHealthState = "healthy" | "stale" | "error" | "paused_auth_failed" | "unknown";

export interface EntityFreshness {
  entity: string;
  health_state: SyncHealthState;
  last_success_at: string | null;
  minutes_stale: number | null;
  bucket: FreshnessBucket;
}

export type SyncRunStatus = "running" | "success" | "error" | "empty_suspect" | null;

export interface SyncRun {
  id: string;
  entity: string;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string | null;
  rows_fetched: number | null;
  rows_upserted: number | null;
  rows_quarantined: number | null;
  error: string | null;
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface OpenAlert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string | null;
  created_at: string;
}

export interface AuthorityRow {
  capability: string;
  read_source: "glofox";
  write_source: "glofox";
  state: "glofox_authoritative";
  cadence: string;
  cutover: null;
}

export interface HealthReport {
  freshness: EntityFreshness[];
  sync_runs: SyncRun[];
  alerts: OpenAlert[];
  authority: AuthorityRow[];
}

/**
 * Fetches GET /health with the Supabase access token. 60s quiet polling: a
 * trust surface that only updates on reload is not a trust surface.
 */
export function useHealthQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["health"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/health", accessToken as string),
    retry: 1,
    refetchInterval: 60_000,
  });
}

const SEVERITY_ORDER: Record<FreshnessBucket, number> = {
  critical: 4,
  stale: 3,
  unknown: 2,
  synced: 1,
  live: 0,
};

/**
 * Worst-of-sources aggregate for the chrome freshness indicator (UX plan §2:
 * the global chrome shows the worst freshness of the current screen).
 */
export function aggregateFreshness(items: EntityFreshness[]): {
  bucket: FreshnessBucket;
  minutesStale: number | null;
} {
  let worst: FreshnessBucket | null = null;
  for (const item of items) {
    if (worst === null || SEVERITY_ORDER[item.bucket] > SEVERITY_ORDER[worst]) {
      worst = item.bucket;
    }
  }
  if (worst === null) {
    return { bucket: "unknown", minutesStale: null };
  }
  const ages = items
    .filter((item) => item.bucket === worst)
    .map((item) => item.minutes_stale)
    .filter((minutes): minutes is number => minutes !== null);
  return { bucket: worst, minutesStale: ages.length > 0 ? Math.max(...ages) : null };
}
