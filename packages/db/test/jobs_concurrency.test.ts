/**
 * jobs-queue concurrency gate (CLAUDE.md invariant #4: "forced double-tick
 * executes once"). Runs ONLY when DATABASE_URL is set — the CI `db` job
 * provides it (plain Postgres, migrations applied); in the normal
 * `pnpm -w test` run the suite self-skips.
 *
 * The connecting role is the CI postgres superuser, which bypasses RLS and may
 * execute the service-role-only app.* functions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const M = 40;
const TEST_KINDS = [
  "noop",
  "kc-dead",
  "kc-reap",
  "kc-backoff",
  "kc-deadletter",
  "kc-stale-c",
  "kc-stale-f",
  "kc-idem",
];

describe.skipIf(!DATABASE_URL)("jobs queue concurrency (requires DATABASE_URL)", () => {
  let c1: Client;
  let c2: Client;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    c1 = new Client({ connectionString: DATABASE_URL });
    c2 = new Client({ connectionString: DATABASE_URL });
    await c1.connect();
    await c2.connect();
    // Remove leftovers from a crashed prior run so counts are exact.
    await c1.query("delete from public.jobs where kind = any($1::text[])", [TEST_KINDS]);
  });

  afterAll(async () => {
    try {
      if (createdJobIds.length > 0) {
        // job_runs rows cascade with their jobs.
        await c1.query("delete from public.jobs where id = any($1::uuid[])", [createdJobIds]);
      }
      await c1.query("delete from public.jobs where kind = any($1::text[])", [TEST_KINDS]);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("double tick: two concurrent claim_jobs calls partition the queue (SKIP LOCKED)", async () => {
    const seeded = await c1.query<{ id: string }>(
      "select app.enqueue_job('noop') as id from generate_series(1, $1)",
      [M],
    );
    const seededIds = seeded.rows.map((r) => r.id);
    createdJobIds.push(...seededIds);

    const [r1, r2] = await Promise.all([
      c1.query<{ id: string }>("select * from app.claim_jobs('w1', $1)", [M]),
      c2.query<{ id: string }>("select * from app.claim_jobs('w2', $1)", [M]),
    ]);
    const ids1 = r1.rows.map((r) => r.id);
    const ids2 = r2.rows.map((r) => r.id);

    const union = new Set([...ids1, ...ids2]);
    const intersection = ids1.filter((id) => ids2.includes(id));

    // No job claimed twice, and every seeded job claimed exactly once.
    expect(intersection).toHaveLength(0);
    expect(union.size).toBe(M);
    for (const id of seededIds) {
      expect(union.has(id)).toBe(true);
    }

    // Each claim was audited into job_runs with status='running'.
    const runs = await c1.query<{ n: number }>(
      "select count(*)::int as n from public.job_runs where job_id = any($1::uuid[]) and status = 'running'",
      [seededIds],
    );
    expect(runs.rows[0]?.n).toBe(M);
  });

  it("a job failed past max_attempts becomes 'dead'", async () => {
    const enq = await c1.query<{ id: string }>(
      "select app.enqueue_job('kc-dead', '{}'::jsonb, null, now(), 100, 1) as id",
    );
    const id = enq.rows[0]?.id;
    expect(id).toBeDefined();
    createdJobIds.push(id as string);

    // The only queued job at this point → claimed here (attempts becomes 1).
    const claimed = await c1.query<{ id: string }>("select * from app.claim_jobs('w-dead', 1)");
    expect(claimed.rows.map((r) => r.id)).toContain(id);

    await c1.query("select app.fail_job($1, 'w-dead', 'boom')", [id]);

    const after = await c1.query<{ status: string; last_error: string | null }>(
      "select status, last_error from public.jobs where id = $1",
      [id],
    );
    expect(after.rows[0]?.status).toBe("dead");
    expect(after.rows[0]?.last_error).toBe("boom");
  });

  it("reap_expired_leases() reclaims a running job whose lease has expired", async () => {
    const enq = await c1.query<{ id: string }>("select app.enqueue_job('kc-reap') as id");
    const id = enq.rows[0]?.id;
    expect(id).toBeDefined();
    createdJobIds.push(id as string);

    const claimed = await c1.query<{ id: string }>("select * from app.claim_jobs('w-reap', 1)");
    expect(claimed.rows.map((r) => r.id)).toContain(id);

    // Simulate a dead worker: the lease is already in the past.
    await c1.query(
      "update public.jobs set lease_until = now() - interval '1 minute' where id = $1",
      [id],
    );

    const reaped = await c1.query<{ n: number }>("select app.reap_expired_leases()::int as n");
    expect(reaped.rows[0]?.n).toBeGreaterThanOrEqual(1);

    const job = await c1.query<{ status: string }>("select status from public.jobs where id = $1", [
      id,
    ]);
    expect(job.rows[0]?.status).toBe("queued");

    // The orphaned run row was finalized as failed.
    const run = await c1.query<{ status: string | null; error: string | null }>(
      "select status, error from public.job_runs where job_id = $1 order by started_at desc limit 1",
      [id],
    );
    expect(run.rows[0]?.status).toBe("failed");
    expect(run.rows[0]?.error).toBe("lease expired");
  });

  it("fail_job with attempts REMAINING backs off (queued, run_after advanced, lease/lock cleared)", async () => {
    // max_attempts 5 → after one claim, attempts=1 < 5, so fail_job re-queues.
    const enq = await c1.query<{ id: string }>(
      "select app.enqueue_job('kc-backoff', '{}'::jsonb, null, now(), 100, 5) as id",
    );
    const id = enq.rows[0]?.id as string;
    createdJobIds.push(id);

    const claimed = await c1.query<{ id: string }>("select id from app.claim_jobs('w-bo', 10)");
    expect(claimed.rows.map((r) => r.id)).toContain(id);

    await c1.query("select app.fail_job($1, 'w-bo', 'transient')", [id]);

    const j = await c1.query<{
      status: string;
      attempts: number;
      locked_by: string | null;
      lease_until: string | null;
      last_error: string | null;
      future: boolean;
    }>(
      "select status, attempts, locked_by, lease_until, last_error, (run_after > now()) as future from public.jobs where id = $1",
      [id],
    );
    const row = j.rows[0];
    // Re-queued for a LATER retry — NOT dead, NOT immediately runnable.
    expect(row?.status).toBe("queued");
    expect(row?.future).toBe(true); // exponential backoff pushed run_after out
    expect(row?.locked_by).toBeNull();
    expect(row?.lease_until).toBeNull();
    expect(row?.attempts).toBe(1); // preserved (fail_job never decrements)
    expect(row?.last_error).toBe("transient");
  });

  it("reap_expired_leases() DEAD-LETTERS a running job whose attempts are exhausted", async () => {
    // max_attempts 1 → the single claim exhausts attempts; an expired lease then
    // dead-letters rather than requeues.
    const enq = await c1.query<{ id: string }>(
      "select app.enqueue_job('kc-deadletter', '{}'::jsonb, null, now(), 100, 1) as id",
    );
    const id = enq.rows[0]?.id as string;
    createdJobIds.push(id);

    const claimed = await c1.query<{ id: string }>("select id from app.claim_jobs('w-dl', 10)");
    expect(claimed.rows.map((r) => r.id)).toContain(id);
    await c1.query("update public.jobs set lease_until = now() - interval '1 minute' where id = $1", [id]);

    await c1.query("select app.reap_expired_leases()");
    const j = await c1.query<{ status: string; last_error: string | null }>(
      "select status, last_error from public.jobs where id = $1",
      [id],
    );
    expect(j.rows[0]?.status).toBe("dead"); // NOT requeued
    expect(j.rows[0]?.last_error).toBe("lease expired (max attempts reached)");
  });

  it("complete_job by a STALE worker is a no-op; the real lease-holder still completes", async () => {
    const enq = await c1.query<{ id: string }>("select app.enqueue_job('kc-stale-c') as id");
    const id = enq.rows[0]?.id as string;
    createdJobIds.push(id);
    const claimed = await c1.query<{ id: string }>("select id from app.claim_jobs('w-real', 10)");
    expect(claimed.rows.map((r) => r.id)).toContain(id);

    // A stale/late worker (not the current locked_by) cannot resurrect the job.
    await c1.query("select app.complete_job($1, 'w-imposter')", [id]);
    let s = await c1.query<{ status: string }>("select status from public.jobs where id = $1", [id]);
    expect(s.rows[0]?.status).toBe("running");

    // The genuine lease-holder completes it.
    await c1.query("select app.complete_job($1, 'w-real')", [id]);
    s = await c1.query<{ status: string }>("select status from public.jobs where id = $1", [id]);
    expect(s.rows[0]?.status).toBe("succeeded");
  });

  it("fail_job by a STALE worker is a no-op (a reclaimed job isn't failed by the old worker)", async () => {
    const enq = await c1.query<{ id: string }>("select app.enqueue_job('kc-stale-f') as id");
    const id = enq.rows[0]?.id as string;
    createdJobIds.push(id);
    const claimed = await c1.query<{ id: string }>("select id from app.claim_jobs('w-real-f', 10)");
    expect(claimed.rows.map((r) => r.id)).toContain(id);

    await c1.query("select app.fail_job($1, 'w-imposter', 'stale error')", [id]);
    const s = await c1.query<{ status: string; last_error: string | null }>(
      "select status, last_error from public.jobs where id = $1",
      [id],
    );
    expect(s.rows[0]?.status).toBe("running"); // untouched by the imposter
    expect(s.rows[0]?.last_error).toBeNull();
  });

  it("enqueue_job with a duplicate idempotency key returns the SAME id (no duplicate row)", async () => {
    const first = await c1.query<{ id: string }>(
      "select app.enqueue_job('kc-idem', '{}'::jsonb, null, now(), 100, 5, 'K1') as id",
    );
    const id1 = first.rows[0]?.id as string;
    createdJobIds.push(id1);
    const second = await c1.query<{ id: string }>(
      "select app.enqueue_job('kc-idem', '{}'::jsonb, null, now(), 100, 5, 'K1') as id",
    );
    expect(second.rows[0]?.id).toBe(id1); // handed back, not re-inserted

    const cnt = await c1.query<{ n: number }>(
      "select count(*)::int as n from public.jobs where kind = 'kc-idem' and idempotency_key = 'K1'",
    );
    expect(cnt.rows[0]?.n).toBe(1);
  });
});
