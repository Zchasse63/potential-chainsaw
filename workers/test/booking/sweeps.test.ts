import { describe, expect, it } from "vitest";
import {
  NO_SHOW_SWEEP_KIND,
  WAITLIST_SWEEP_KIND,
  createBookingProcessors,
  runNoShowSweep,
  runWaitlistSweep,
} from "../../src/booking/sweeps.js";
import type { JobRow, TickCtx } from "../../src/processors.js";

/**
 * Phase 6 · unit 6.2 — the two booking-engine sweeps ride the ONE scheduler
 * (invariant #4). These are mocked-pool unit tests: they assert the processor
 * issues the correct RPC (the SQL semantics — FIFO promotion cascade, offer
 * expiry, the no-show window — are proven against a live DB by rls_attack.sql
 * block 33). No wall-clock in the library: now() is evaluated inside Postgres.
 */

interface Call {
  text: string;
  values: readonly unknown[];
}

function fakePool(rows: unknown[]): { query: TickCtx["pool"]["query"]; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    tenant_id: null,
    kind: WAITLIST_SWEEP_KIND,
    payload: {},
    priority: 100,
    run_after: "2026-07-19T00:00:00.000Z",
    status: "running",
    attempts: 1,
    max_attempts: 5,
    lease_until: null,
    locked_by: "w-test",
    last_error: null,
    idempotency_key: null,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

const TENANT = "11111111-1111-1111-1111-111111111111";

describe("booking sweeps registration", () => {
  it("registers both the waitlist and no-show sweep kinds", () => {
    const procs = createBookingProcessors();
    expect(procs[WAITLIST_SWEEP_KIND]).toBeTypeOf("function");
    expect(procs[NO_SHOW_SWEEP_KIND]).toBeTypeOf("function");
  });
});

describe("runWaitlistSweep — GLOBAL lapsed-offer settle + cascade promote", () => {
  it("calls app.decline_or_expire_offers(now()) with no tenant scoping", async () => {
    const pool = fakePool([{ n: 3 }]);
    await runWaitlistSweep(makeJob({ tenant_id: null }), { pool, workerId: "w-test" });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.text).toContain("app.decline_or_expire_offers(now())");
    // GLOBAL: the RPC scans every tenant, so no tenant bind param is threaded.
    expect(pool.calls[0]!.values).toEqual([]);
  });

  it("parses a non-negative settled count and does not throw on zero", async () => {
    const pool = fakePool([{ n: 0 }]);
    await expect(
      runWaitlistSweep(makeJob(), { pool, workerId: "w-test" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a malformed (negative) count row shape", async () => {
    const pool = fakePool([{ n: -1 }]);
    await expect(runWaitlistSweep(makeJob(), { pool, workerId: "w-test" })).rejects.toThrow();
  });
});

describe("runNoShowSweep — DAILY per-tenant forfeit", () => {
  it("requires a tenant-scoped job row (fails loudly on a null tenant)", async () => {
    const pool = fakePool([{ n: 0 }]);
    await expect(
      runNoShowSweep(makeJob({ kind: NO_SHOW_SWEEP_KIND, tenant_id: null }), {
        pool,
        workerId: "w-test",
      }),
    ).rejects.toThrow(/requires a tenant-scoped job row/);
    expect(pool.calls).toHaveLength(0);
  });

  it("calls app.mark_no_shows(tenant, now()) with the job's tenant bound", async () => {
    const pool = fakePool([{ n: 2 }]);
    await runNoShowSweep(makeJob({ kind: NO_SHOW_SWEEP_KIND, tenant_id: TENANT }), {
      pool,
      workerId: "w-test",
    });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.text).toContain("app.mark_no_shows($1::uuid, now())");
    expect(pool.calls[0]!.values).toEqual([TENANT]);
  });
});
