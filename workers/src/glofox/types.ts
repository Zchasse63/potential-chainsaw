import type { GlofoxFetch } from "@kelo/contracts";
import type { Queryable } from "../processors.js";

/**
 * Phase 1 · unit 4 — shared types for the Glofox sync pipeline (plan-final §4
 * "The pipeline (per tenant × entity × window)"). The pipeline owns the
 * WATERMARK LAW and the five freshness tripwires; entity specs own only what
 * differs per entity (how to page, how to map, how to upsert).
 */

/** A pg Pool satisfies this; unit tests inject a recording fake (no connect). */
export interface PooledQueryable extends Queryable {
  connect?: () => Promise<{ query: Queryable["query"]; release: () => void }>;
}

/**
 * The slice of the Glofox client the sync path uses. Sync fetches go through
 * `fetch` — the RAW GlofoxFetch (headers/pacing/retries/trap-1 all apply,
 * returns unknown) — so the raw page can be written to glofox_raw BEFORE any
 * parse (the typed endpoint wrappers parse inside and would lose the raw body
 * on a page-parse throw; they remain for probes/tools). `branchGet` is the
 * timezone fallback when the tenant's locations row is missing.
 */
export interface SyncGlofoxClient {
  readonly fetch: GlofoxFetch;
  readonly branchGet?: () => Promise<{ address: { timezone_id: string } }>;
}

/** Per-run identity: which tenant, which queue job, and the injectable clock. */
export interface SyncRunContext {
  readonly tenantId: string;
  readonly jobId: string | null;
  /** The Glofox branch id (== locations.external_ref) for timezone resolution. */
  readonly branchId?: string;
  /** REQUIRED for the transactions report body — omitting it silently empties it (trap 2). */
  readonly namespace?: string;
  /** Injectable for tests; processors pass `() => new Date()`. */
  readonly now: () => Date;
  /** Arbitrary job payload (credits cursor, transactions backfillStart). */
  readonly payload: Record<string, unknown>;
}

/** sync_state row as read by the pipeline (migration 0006 + 0010). */
export interface SyncStateRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly entity: string;
  readonly committed_watermark: string | null;
  readonly candidate_watermark: string | null;
  readonly consecutive_empty: number;
  readonly expected_min_records: number | null;
  readonly last_run_at: string | null;
  readonly last_success_at: string | null;
  readonly health_state: "healthy" | "stale" | "error" | "paused_auth_failed" | "unknown";
  readonly plausible_zero: boolean;
  readonly empty_alarm_threshold: number;
  readonly paused: boolean;
}

/**
 * One quarantine insert (migration 0007 minus server columns). Structurally
 * identical to BOTH mapper QuarantineRow shapes (mappers/types.ts list-shape
 * and mappers/facts-types.ts single-row shape) — the unification of the two
 * mapper result shapes happens HERE, in the sync layer, never in the mappers.
 */
export interface SyncQuarantineRow {
  readonly entity: string;
  readonly external_ref: string | null;
  readonly reason: string;
  readonly payload: unknown;
}

/** The two mapper result shapes, unified. */
export type AnyMapperResult<TRow> =
  | { readonly rows: readonly TRow[]; readonly quarantine: readonly SyncQuarantineRow[] }
  | { readonly row: TRow | null; readonly quarantine: readonly SyncQuarantineRow[] };

export function normalizeMapperResult<TRow>(result: AnyMapperResult<TRow>): {
  rows: TRow[];
  quarantine: SyncQuarantineRow[];
} {
  if ("rows" in result) {
    return { rows: [...result.rows], quarantine: [...result.quarantine] };
  }
  return {
    rows: result.row === null ? [] : [result.row],
    quarantine: [...result.quarantine],
  };
}

/** One fetched page/report, pre-parse — exactly what glofox_raw persists. */
export interface RawFetch {
  /** glofox_raw.endpoint, e.g. "/2.0/members". */
  readonly endpoint: string;
  /** Request context for replay/debug (method, path, query, page). */
  readonly requestMeta: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query?: Record<string, string | number | boolean>;
    readonly body?: Record<string, unknown>;
    readonly page?: number;
  };
  /** The raw parsed-JSON body as returned by client.fetch (unknown). */
  readonly payload: unknown;
}

/** A fetch window. Full-list entities use a degenerate snapshot "window". */
export interface SyncWindow {
  readonly start: Date | null;
  readonly end: Date;
}

/** What one batch (one page, or one report window) carried in. */
export interface BatchOutcome {
  /** Raw rows on the page (pre-salvage) — feeds rows_fetched + the zero-row law. */
  readonly rowsFetched: number;
  readonly rowsUpserted: number;
  readonly rowsQuarantined: number;
  /** The candidate watermark committed in this batch's transaction. */
  readonly candidate: Date;
}

/**
 * The per-entity contract. `TRow` is the mapper's DB-row shape; the spec never
 * touches watermarks, sync_runs, alerts, or the raw zone — the pipeline does.
 */
export interface EntitySpec<TRow> {
  /** Glofox entity vocabulary: 'members' | 'memberships' | 'events' | 'bookings' | 'transactions' | 'credits'. */
  readonly entity: string;
  /** From the mapper files; recorded in each raw page's request_meta. */
  readonly mapperVersion: number;
  /** Tripwire 2/3 seed config, applied when the sync_state row is first created. */
  readonly defaults: { readonly plausibleZero: boolean; readonly emptyAlarmThreshold?: number };
  /**
   * Does a run with no committed watermark constitute a FULL backfill for
   * tripwire 4 (expected_min_records)? Full-list entities are always full.
   */
  readonly fullListEveryRun: boolean;
  /** True when the mapper needs ctx.timezone (facts mappers) → resolve branch tz. */
  readonly needsTimezone: boolean;
  /** The windows this run fetches, from the current state + clock. */
  readonly windows: (state: SyncStateRow, ctx: SyncRunContext) => SyncWindow[];
  /** Pages of one window, RAW (client.fetch), in fetch order. The pool is
   * available for entity-driven iteration (credits pages per-member from people). */
  readonly pages: (
    pool: PooledQueryable,
    client: SyncGlofoxClient,
    window: SyncWindow,
    ctx: SyncRunContext,
  ) => AsyncGenerator<RawFetch, void, undefined>;
  /**
   * LENIENT envelope parse: structure only, rows as unknown[]. A throw here is
   * an ENVELOPE-level failure — the run is schema-invalid (watermark law:
   * committed never advances; the error path applies).
   */
  readonly extractRows: (payload: unknown) => unknown[];
  /** Per-row STRICT parse + mapper (per-row salvage: one bad row never kills a page). */
  readonly mapRow: (
    row: unknown,
    mapCtx: { tenantId: string; timezone: string },
  ) => { rows: TRow[]; quarantine: SyncQuarantineRow[] };
  /**
   * The batch upsert, inside the pipeline's transaction. Returns upsert count
   * plus any DB-level quarantines (e.g. duplicate-email merge review).
   */
  readonly upsertBatch: (
    tx: Queryable,
    rows: TRow[],
    ctx: SyncRunContext,
  ) => Promise<{ upserted: number; quarantine: SyncQuarantineRow[] }>;
  /** The candidate watermark a completed batch commits (usually window.end). */
  readonly candidateFor: (window: SyncWindow, ctx: SyncRunContext) => Date;
  /** Optional post-success hook (credits re-enqueues its next chunk). */
  readonly afterSuccess?: (pool: PooledQueryable, ctx: SyncRunContext) => Promise<void>;
}

/** How a run ended — returned for tests and processor logging. */
export interface SyncOutcome {
  readonly status: "success" | "empty_suspect" | "paused" | "error";
  readonly syncRunId: string | null;
  readonly rowsFetched: number;
  readonly rowsUpserted: number;
  readonly rowsQuarantined: number;
}
