import { describe, expect, it } from "vitest";
import { processors, type JobRow, type Queryable, type TickCtx } from "../../src/processors.js";
import { BOOKING_EXPIRE_HOLDS_KIND, runExpireHolds } from "../../src/booking/expire-holds.js";

interface QueryCall {
  text: string;
  values?: readonly unknown[];
}

interface Hold {
  id: string;
  expires_at: string; // ISO-8601 UTC (lexicographic compare == chronological)
  frozen: boolean;
}

/**
 * Fake pool that MODELS app.expire_holds's contract: it deletes only the holds
 * that are expired (expires_at < p_now) AND not frozen — exactly the SQL guard —
 * so the test proves the sweep never reclaims a frozen (mid-tender) seat. If the
 * processor ever issued a raw unconditional DELETE instead of delegating to the
 * guarded function, this fake would not recognize it and the assertions below
 * would fail.
 */
function fakeHoldsPool(holds: Hold[]): { pool: Queryable; calls: QueryCall[]; holds: Hold[] } {
  const calls: QueryCall[] = [];
  const pool: Queryable = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      if (text.includes("app.expire_holds")) {
        const now = String(values?.[0]);
        const survivors = holds.filter((h) => !(h.expires_at < now && !h.frozen));
        const deleted = holds.length - survivors.length;
        holds.length = 0;
        holds.push(...survivors);
        return { rows: [{ deleted }] };
      }
      return { rows: [] };
    },
  };
  return { pool, calls, holds };
}

const NOW = new Date("2026-07-19T12:00:00.000Z");
const nowFn = () => NOW;

describe("runExpireHolds — the hold-expiry sweep", () => {
  it("delegates to the guarded app.expire_holds function with the injected now (never a raw DELETE)", async () => {
    const { pool, calls } = fakeHoldsPool([]);
    await runExpireHolds(pool, { now: nowFn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("app.expire_holds");
    // Delegation, not an ad-hoc unconditional DELETE (the frozen guard is in SQL).
    expect(calls[0]?.text.toLowerCase()).not.toContain("delete from");
    expect(calls[0]?.values).toEqual([NOW.toISOString()]);
  });

  it("NEVER deletes a frozen hold, even when it is expired (mid-tender seat is safe)", async () => {
    const holds: Hold[] = [
      { id: "expired-unfrozen", expires_at: "2026-07-19T11:59:00.000Z", frozen: false },
      { id: "expired-FROZEN", expires_at: "2026-07-19T11:00:00.000Z", frozen: true },
      { id: "live-unfrozen", expires_at: "2026-07-19T12:05:00.000Z", frozen: false },
    ];
    const { pool } = fakeHoldsPool(holds);
    const deleted = await runExpireHolds(pool, { now: nowFn });

    // Only the expired UN-frozen hold is reclaimed.
    expect(deleted).toBe(1);
    const surviving = holds.map((h) => h.id).sort();
    expect(surviving).toEqual(["expired-FROZEN", "live-unfrozen"]);
  });

  it("returns the deleted count as a number even when the driver yields a string", async () => {
    const pool: Queryable = { query: async () => ({ rows: [{ deleted: "4" }] }) };
    expect(await runExpireHolds(pool, { now: nowFn })).toBe(4);
  });

  it("is registered under booking.expire_holds and runs GLOBALLY (no tenant on the job)", async () => {
    const holds: Hold[] = [{ id: "e", expires_at: "2026-07-19T10:00:00.000Z", frozen: false }];
    const { pool, calls } = fakeHoldsPool(holds);
    const processor = processors[BOOKING_EXPIRE_HOLDS_KIND];
    expect(processor).toBeDefined();

    const job = { id: "j1", tenant_id: null, kind: BOOKING_EXPIRE_HOLDS_KIND, payload: {} } as unknown as JobRow;
    const ctx = { pool, workerId: "w-test" } as unknown as TickCtx;
    await processor!(job, ctx);

    expect(calls.some((c) => c.text.includes("app.expire_holds"))).toBe(true);
    expect(holds).toHaveLength(0); // the expired unfrozen hold was reclaimed
  });
});
