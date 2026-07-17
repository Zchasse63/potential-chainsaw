import { afterEach, describe, expect, it, vi } from "vitest";
import { processors, type JobRow, type Queryable } from "../src/processors.js";
import { runTick } from "../src/tick.js";

interface QueryCall {
  text: string;
  values?: readonly unknown[];
}

/** Fake pool: routes the four app.* calls the tick makes; records everything. */
function fakePool(claimed: JobRow[]): { pool: Queryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool: Queryable = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      if (text.includes("claim_jobs")) return { rows: claimed };
      return { rows: [] };
    },
  };
  return { pool, calls };
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: null,
    kind: "noop",
    payload: {},
    priority: 100,
    run_after: new Date().toISOString(),
    status: "running",
    attempts: 1,
    max_attempts: 5,
    lease_until: null,
    locked_by: "w-test",
    last_error: null,
    idempotency_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete processors["test-boom"];
});

describe("runTick", () => {
  it("reaps expired leases before claiming", async () => {
    const { pool, calls } = fakePool([]);
    await runTick(pool, { workerId: "w-test" });
    expect(calls[0]?.text).toContain("reap_expired_leases");
    expect(calls[1]?.text).toContain("claim_jobs");
    expect(calls[1]?.values).toEqual(["w-test", 10]);
  });

  it("dispatches a claimed job to its processor and completes it on success", async () => {
    const job = makeJob();
    const { pool, calls } = fakePool([job]);
    const result = await runTick(pool, { workerId: "w-test" });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    const complete = calls.find((c) => c.text.includes("complete_job"));
    expect(complete?.values).toEqual([job.id, "w-test"]);
    expect(calls.some((c) => c.text.includes("fail_job"))).toBe(false);
  });

  it("fails the job with the processor's error message on throw", async () => {
    processors["test-boom"] = async () => {
      throw new Error("kaboom");
    };
    const job = makeJob({ kind: "test-boom" });
    const { pool, calls } = fakePool([job]);
    const result = await runTick(pool, { workerId: "w-test" });

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    const fail = calls.find((c) => c.text.includes("fail_job"));
    expect(fail?.values).toEqual([job.id, "w-test", "kaboom"]);
    expect(calls.some((c) => c.text.includes("complete_job"))).toBe(false);
  });

  it("fails loudly on an unknown job kind (never silently succeeds)", async () => {
    const job = makeJob({ kind: "mystery" });
    const { pool, calls } = fakePool([job]);
    const result = await runTick(pool, { workerId: "w-test" });

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    const fail = calls.find((c) => c.text.includes("fail_job"));
    expect(fail?.values?.[2]).toBe("unknown job kind: mystery");
    expect(calls.some((c) => c.text.includes("complete_job"))).toBe(false);
  });

  it("pings the heartbeat URL after the cycle", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { pool } = fakePool([]);
    await runTick(pool, { workerId: "w-test", heartbeatUrl: "https://hc.example/ping" });
    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/ping");
  });

  it("a heartbeat outage never breaks the tick", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { pool } = fakePool([makeJob()]);
    const result = await runTick(pool, {
      workerId: "w-test",
      heartbeatUrl: "https://hc.example/ping",
    });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
  });
});
