import { createHash } from "node:crypto";

/**
 * Row shape for `public.glofox_raw` inserts (migration 0007) — the immutable
 * raw zone: every fetched page lands here hash-deduped BEFORE transform, so any
 * mapping bug is fixed by re-transforming from raw (plan-final §4 "The
 * pipeline" step 1). The DB write happens in the sync jobs (phase 1.4) —
 * @kelo/glofox stays DB-free and exports only this pure helper + its types.
 */

/** What the caller was doing when the page was fetched (replay/debug context). */
export interface RawPageRequestMeta {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Record<string, string | number | boolean>;
  readonly body?: Record<string, unknown>;
  readonly page?: number;
}

/** request_meta as stored: the request params PLUS namespace presence. */
export interface GlofoxRawRequestMeta extends RawPageRequestMeta {
  /**
   * TRAP-2 telemetry (README §3): was `namespace` present on the request?
   * Recorded so a silently-empty report can be audited back to its request.
   */
  readonly namespace_present: boolean;
}

/** The glofox_raw row minus server-side columns (id, sync_run_id, timestamps). */
export interface GlofoxRawPage {
  readonly endpoint: string;
  readonly request_meta: GlofoxRawRequestMeta;
  readonly payload: unknown;
  /** sha256 hex of the canonical JSON payload — the hash-dedup key. */
  readonly payload_hash: string;
}

/**
 * Deterministic stringify: object keys sorted recursively (array order kept),
 * so two fetches of the same page hash identically regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, sortKeys(v)]),
    );
  }
  return value;
}

function hasNamespace(meta: RawPageRequestMeta): boolean {
  const values = [meta.query?.["namespace"], meta.body?.["namespace"]];
  return values.some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * Builds the glofox_raw insert shape for one fetched page/report. Pure: no DB,
 * no clock — the sync layer adds tenant_id, sync_run_id, and timestamps and
 * inserts with ON CONFLICT (tenant_id, endpoint, payload_hash) DO NOTHING.
 */
export function rawPageEnvelope(
  endpoint: string,
  requestMeta: RawPageRequestMeta,
  payload: unknown,
): GlofoxRawPage {
  return {
    endpoint,
    request_meta: { ...requestMeta, namespace_present: hasNamespace(requestMeta) },
    payload,
    payload_hash: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
  };
}
