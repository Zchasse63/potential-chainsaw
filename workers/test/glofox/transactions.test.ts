import { describe, expect, it } from "vitest";
import { runEntitySync } from "../../src/glofox/pipeline.js";
import { transactionsSpec } from "../../src/glofox/entities/transactions.js";
import {
  callsMatching,
  createFakeClient,
  createFakePool,
  makeCtx,
  NOW,
  reportPage,
  stripeChargeRow,
} from "./helpers.js";

/**
 * Transactions windowing (README §7.1: no cursor — 7-day windows marching
 * forward, resumable from the committed watermark, bounded per run).
 */

const DAY = 24 * 60 * 60 * 1000;
const unix = (d: Date): string => String(Math.floor(d.getTime() / 1000));

function reportBodies(
  client: ReturnType<typeof createFakeClient>,
): { start: string; end: string }[] {
  return client.calls.map((call) => call.init?.body as { start: string; end: string });
}

describe("transactions window marching", () => {
  it("marches 7-day windows from the committed watermark to now", async () => {
    const committed = new Date(NOW.getTime() - 20 * DAY);
    const pool = createFakePool({
      syncState: { committed_watermark: committed.toISOString(), plausible_zero: true },
    });
    const client = createFakeClient(() => reportPage([]));

    const outcome = await runEntitySync(pool, client, makeCtx(), transactionsSpec);

    expect(outcome.status).toBe("success");
    const bodies = reportBodies(client);
    expect(bodies).toHaveLength(3); // 20d → 3 windows (7+7+6)
    expect(bodies[0]).toMatchObject({
      start: unix(committed),
      end: unix(new Date(committed.getTime() + 7 * DAY)),
    });
    expect(bodies[1]?.start).toBe(bodies[0]?.end);
    expect(bodies[2]?.end).toBe(unix(NOW));
    // Trap 2 guard: every body carries branch_id + namespace.
    for (const call of client.calls) {
      const body = call.init?.body as Record<string, unknown>;
      expect(body["namespace"]).toBe("test-namespace");
      expect(body["branch_id"]).toBe("test-branch-id");
      expect(call.init?.method).toBe("POST");
    }
    // Caught up: committed advanced to now.
    const advance = callsMatching(pool.calls, "set committed_watermark");
    expect(advance[0]?.values?.[2]).toBe(NOW.toISOString());
  });

  it("processes at most 8 windows per run — resumable from the last candidate", async () => {
    const committed = new Date(NOW.getTime() - 60 * DAY);
    const pool = createFakePool({
      syncState: { committed_watermark: committed.toISOString(), plausible_zero: true },
    });
    const client = createFakeClient(() => reportPage([]));

    await runEntitySync(pool, client, makeCtx(), transactionsSpec);

    expect(client.calls).toHaveLength(8); // the bounded loop, not 9
    const expectedCandidate = new Date(committed.getTime() + 8 * 7 * DAY);
    const advance = callsMatching(pool.calls, "set committed_watermark");
    // NOT caught up: committed advanced only to window 8's end (committed+56d = now−4d).
    expect(advance[0]?.values?.[2]).toBe(expectedCandidate.toISOString());
    // Per-window candidates committed in order inside their own transactions.
    const candidates = callsMatching(pool.calls, "set candidate_watermark");
    expect(candidates).toHaveLength(8);
    expect(candidates[0]?.values?.[2]).toBe(new Date(committed.getTime() + 7 * DAY).toISOString());
    expect(candidates[7]?.values?.[2]).toBe(expectedCandidate.toISOString());
  });

  it("first run with no watermark uses payload.backfillStart when provided", async () => {
    const pool = createFakePool({ syncState: { plausible_zero: true } });
    const client = createFakeClient(() => reportPage([]));

    await runEntitySync(
      pool,
      client,
      makeCtx({ payload: { backfillStart: new Date(NOW.getTime() - 10 * DAY).toISOString() } }),
      transactionsSpec,
    );

    const bodies = reportBodies(client);
    expect(bodies).toHaveLength(2); // 10d → 2 windows
    expect(bodies[0]?.start).toBe(unix(new Date(NOW.getTime() - 10 * DAY)));
  });

  it("first run without backfillStart fetches a single trailing 7-day window", async () => {
    const pool = createFakePool({ syncState: { plausible_zero: true } });
    const client = createFakeClient(() => reportPage([]));

    await runEntitySync(pool, client, makeCtx(), transactionsSpec);

    const bodies = reportBodies(client);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.start).toBe(unix(new Date(NOW.getTime() - 7 * DAY)));
    expect(bodies[0]?.end).toBe(unix(NOW));
  });

  it("empty windows are plausible here: zero rows still advance (trap-2 is guarded upstream)", async () => {
    const pool = createFakePool({ syncState: { plausible_zero: true } });
    const client = createFakeClient(() => reportPage([]));

    const outcome = await runEntitySync(pool, client, makeCtx(), transactionsSpec);

    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(0);
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(1);
  });

  it("rows upsert per window; unknown wrappers quarantine without blocking the march", async () => {
    const committed = new Date(NOW.getTime() - 8 * DAY); // exactly 2 windows
    const pool = createFakePool({
      syncState: { committed_watermark: committed.toISOString(), plausible_zero: true },
    });
    const rows = [stripeChargeRow("t1"), stripeChargeRow("t2")];
    let call = 0;
    const client = createFakeClient(() => {
      call += 1;
      return call === 1 ? reportPage(rows) : reportPage([]);
    });

    const outcome = await runEntitySync(pool, client, makeCtx(), transactionsSpec);

    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(2);
    expect(outcome.rowsUpserted).toBe(2);
    const upserts = callsMatching(pool.calls, "insert into public.glofox_transactions");
    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.text).toContain("on conflict (tenant_id, external_ref)");
  });
});
