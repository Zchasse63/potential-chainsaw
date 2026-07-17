import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardWorkerSecret, WORKER_SECRET_HEADER } from "../../../netlify/src/worker-guard.js";

// Threat model §6: publicly addressable worker endpoints verify the shared
// secret BEFORE touching the queue, and act only on queue rows.

const poolMocks = vi.hoisted(() => ({
  query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(),
  end: vi.fn<() => Promise<void>>(),
}));

vi.mock("@kelo/db", () => ({
  createDbPool: () => ({ query: poolMocks.query, end: poolMocks.end }),
}));

// Imported AFTER the mock so the handler picks up the fake pool.
const { default: workerRunBackground } =
  await import("../../../netlify/functions/worker-run-background.mts");

const WORKER_URL = "https://example.com/.netlify/functions/worker-run-background";

describe("guardWorkerSecret (pure guard)", () => {
  it("returns 401 when the secret header is missing", () => {
    const res = guardWorkerSecret(new Headers(), "s3cret");
    expect(res?.status).toBe(401);
  });

  it("returns 401 on a mismatched secret", () => {
    const res = guardWorkerSecret(new Headers({ [WORKER_SECRET_HEADER]: "wrong" }), "s3cret");
    expect(res?.status).toBe(401);
  });

  it("returns 401 when the expected secret is not configured", () => {
    const res = guardWorkerSecret(new Headers({ [WORKER_SECRET_HEADER]: "s3cret" }), undefined);
    expect(res?.status).toBe(401);
  });

  it("passes (null) when the secrets match", () => {
    expect(
      guardWorkerSecret(new Headers({ [WORKER_SECRET_HEADER]: "s3cret" }), "s3cret"),
    ).toBeNull();
  });
});

describe("worker-run-background handler", () => {
  beforeEach(() => {
    vi.stubEnv("WORKER_SHARED_SECRET", "s3cret");
    vi.stubEnv("HEARTBEAT_PING_URL", "");
    poolMocks.query.mockResolvedValue({ rows: [] });
    poolMocks.end.mockResolvedValue(undefined);
    return () => {
      vi.unstubAllEnvs();
      poolMocks.query.mockReset();
      poolMocks.end.mockReset();
    };
  });

  it("returns 401 BEFORE any queue access when the secret is missing", async () => {
    const res = await workerRunBackground(new Request(WORKER_URL));
    expect(res.status).toBe(401);
    expect(poolMocks.query).not.toHaveBeenCalled();
  });

  it("returns 401 BEFORE any queue access when the secret is wrong", async () => {
    const res = await workerRunBackground(
      new Request(WORKER_URL, { headers: { [WORKER_SECRET_HEADER]: "wrong" } }),
    );
    expect(res.status).toBe(401);
    expect(poolMocks.query).not.toHaveBeenCalled();
  });

  it("runs the tick against the queue when the secret matches (mocked pool)", async () => {
    const res = await workerRunBackground(
      new Request(WORKER_URL, { headers: { [WORKER_SECRET_HEADER]: "s3cret" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: number; succeeded: number; failed: number };
    expect(body).toEqual({ claimed: 0, succeeded: 0, failed: 0 });

    // It acted solely on queue rows via app.* queue functions…
    expect(poolMocks.query).toHaveBeenCalledWith("select app.reap_expired_leases()");
    expect(poolMocks.query).toHaveBeenCalledWith("select * from app.claim_jobs($1, $2)", [
      "netlify-worker-run",
      25,
    ]);
    expect(poolMocks.end).toHaveBeenCalled();
  });
});
