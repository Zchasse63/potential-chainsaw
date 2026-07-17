import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlofoxConfig } from "@kelo/glofox";
import type { JobRow } from "../../src/processors.js";
import type {
  PooledQueryable,
  SyncGlofoxClient,
  SyncRunContext,
  SyncStateRow,
} from "../../src/glofox/types.js";

/**
 * Test doubles for the Glofox sync layer (phase 1 · unit 4). NO network, NO
 * DB: a recording fake pool with programmable responders, and a fake client
 * replaying canned pages built from the pinned PII-redacted samples.
 */

/** Absolute path to the pinned samples (docs/glofox/samples/). */
const SAMPLES_DIR = fileURLToPath(new URL("../../../docs/glofox/samples/", import.meta.url));

export function loadSample(fileName: string): unknown {
  return JSON.parse(readFileSync(join(SAMPLES_DIR, fileName), "utf8")) as unknown;
}

export const TENANT = "00000000-0000-0000-0000-0000000000aa";

export const testConfig: GlofoxConfig = {
  baseUrl: "https://gf-api.aws.glofox.com/prod/",
  apiKey: "test-api-key",
  apiToken: "test-api-token",
  branchId: "test-branch-id",
  namespace: "test-namespace",
};

/** Fixed clock: deterministic windows, candidates, and idempotency keys. */
export const NOW = new Date("2026-07-17T23:00:00.000Z");
export const fixedNow = (): Date => new Date(NOW.getTime());

// --- fake pool -------------------------------------------------------------------

export interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

export interface FakePoolOverrides {
  /** The sync_state row the SELECT returns (defaults: fresh, unpaused, no watermarks). */
  readonly syncState?: Partial<SyncStateRow>;
  /** consecutive_empty returned by the suspect-empty UPDATE … RETURNING. */
  readonly consecutiveEmpty?: number;
  /**
   * Last-resort responder, consulted BEFORE the defaults. Return undefined to
   * fall through; throw to simulate a DB error (e.g. 23505).
   */
  readonly respond?: (
    text: string,
    values: readonly unknown[] | undefined,
    calls: readonly QueryCall[],
  ) => { rows: unknown[] } | undefined;
}

export function createFakePool(overrides: FakePoolOverrides = {}): PooledQueryable & {
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const state: Record<string, unknown> = {
    id: "state-1",
    tenant_id: TENANT,
    entity: "members",
    committed_watermark: null,
    candidate_watermark: null,
    consecutive_empty: 0,
    expected_min_records: null,
    last_run_at: null,
    last_success_at: null,
    health_state: "unknown",
    plausible_zero: false,
    empty_alarm_threshold: 3,
    paused: false,
    ...overrides.syncState,
  };
  let personSeq = 0;

  const defaults = (text: string, values: readonly unknown[] | undefined): { rows: unknown[] } => {
    if (text.includes("insert into public.sync_runs")) return { rows: [{ id: "run-1" }] };
    if (text.includes("from public.sync_state")) return { rows: [state] };
    if (text.includes("returning consecutive_empty")) {
      return { rows: [{ consecutive_empty: overrides.consecutiveEmpty ?? 1 }] };
    }
    if (text.includes("from public.locations")) return { rows: [{ timezone: "America/New_York" }] };
    if (text.includes("insert into public.people")) {
      personSeq += 1;
      return { rows: [{ id: `person-${personSeq}` }] };
    }
    void values;
    return { rows: [] };
  };

  return {
    calls,
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      const custom = overrides.respond?.(text, values, calls);
      if (custom !== undefined) return custom;
      return defaults(text, values);
    },
  };
}

// --- fake Glofox client ------------------------------------------------------------

export interface FetchCall {
  readonly path: string;
  readonly init?: { method?: "GET" | "POST"; body?: unknown };
}

export function createFakeClient(
  handler: (path: string, init?: { method?: "GET" | "POST"; body?: unknown }) => unknown,
  extras: { branchGet?: () => Promise<{ address: { timezone_id: string } }> } = {},
): SyncGlofoxClient & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (path, init) => {
      calls.push({ path, init });
      return handler(path, init);
    },
    ...(extras.branchGet ? { branchGet: extras.branchGet } : {}),
  };
}

// --- canned pages from the pinned samples -------------------------------------------

/** Deep clone (samples are reused across tests — never mutate the parsed JSON). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A Style A envelope carrying the given rows (single page, has_more false). */
export function styleAPage(rows: unknown[], page = 1, hasMore = false): unknown {
  return {
    object: "list",
    page,
    limit: 100,
    has_more: hasMore,
    total_count: rows.length,
    data: rows,
  };
}

/** A valid member row cloned from the pinned sample, identity overridden. */
export function memberRow(id: string, email = `member-${id}@example.com`): Record<string, unknown> {
  const sample = loadSample("members.get.limit2.json") as { data: Record<string, unknown>[] };
  const row = clone(sample.data[0]!);
  row["_id"] = id;
  row["email"] = email;
  return row;
}

/** A valid Style C transactions report carrying the given detail rows. */
export function reportPage(details: unknown[]): unknown {
  return { TransactionsList: { header: "Transactions", details } };
}

/** A valid StripeCharge-wrapped detail row, identity/status overridden. */
export function stripeChargeRow(id: string): Record<string, unknown> {
  const sample = loadSample("analytics.report.30d.json") as {
    TransactionsList: { details: Record<string, unknown>[] };
  };
  const detail = clone(sample.TransactionsList.details[0]!);
  const charge = detail["StripeCharge"] as Record<string, unknown>;
  charge["_id"] = id;
  return detail;
}

// --- ctx / job builders -------------------------------------------------------------

export function makeCtx(overrides: Partial<SyncRunContext> = {}): SyncRunContext {
  return {
    tenantId: TENANT,
    jobId: "job-1",
    branchId: testConfig.branchId,
    namespace: testConfig.namespace,
    now: fixedNow,
    payload: {},
    ...overrides,
  };
}

export function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: TENANT,
    kind: "glofox.sync.members",
    payload: {},
    priority: 100,
    run_after: NOW.toISOString(),
    status: "running",
    attempts: 1,
    max_attempts: 5,
    lease_until: null,
    locked_by: "w-test",
    last_error: null,
    idempotency_key: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

// --- assertion helpers ----------------------------------------------------------------

export function callsMatching(calls: readonly QueryCall[], needle: string): QueryCall[] {
  return calls.filter((call) => call.text.includes(needle));
}

export function firstIndex(calls: readonly QueryCall[], needle: string): number {
  return calls.findIndex((call) => call.text.includes(needle));
}
