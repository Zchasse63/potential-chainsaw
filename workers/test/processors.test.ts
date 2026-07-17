import { afterEach, describe, expect, it, vi } from "vitest";
import { processors, type JobRow, type TickCtx } from "../src/processors.js";

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

function makeCtx(heartbeatUrl?: string): TickCtx {
  return {
    pool: { query: async () => ({ rows: [] }) },
    workerId: "w-test",
    heartbeatUrl,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("processors registry", () => {
  it("registers 'noop' and 'heartbeat'", () => {
    expect(Object.keys(processors)).toEqual(expect.arrayContaining(["noop", "heartbeat"]));
  });

  it("'noop' resolves", async () => {
    await expect(processors["noop"]?.(makeJob(), makeCtx())).resolves.toBeUndefined();
  });

  it("'heartbeat' pings the configured URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await processors["heartbeat"]?.(
      makeJob({ kind: "heartbeat" }),
      makeCtx("https://hc.example/ping"),
    );
    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/ping");
  });

  it("'heartbeat' does nothing without a configured URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await processors["heartbeat"]?.(makeJob({ kind: "heartbeat" }), makeCtx());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
