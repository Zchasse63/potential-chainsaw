import { describe, expect, it } from "vitest";
import { runReconciliation } from "../../src/glofox/reconcile/reconcile.js";
import {
  callsMatching,
  clone,
  createFakeClient,
  createFakePool,
  loadSample,
  makeCtx,
  memberRow,
  NOW,
  reportPage,
  stripeChargeRow,
  TENANT,
} from "./helpers.js";

/**
 * THE RECONCILIATION ENGINE (phase 1 · unit 5) — tripwire 5, the trust engine.
 * Match / drift / error rows, the money reconciliation, the single-sided
 * member canary, and the drift alert. NO network, NO DB.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A Style A members page whose total_count differs from the page size (the
 * count-only read: page 1, limit 1). */
function membersCountPage(totalCount: number): unknown {
  return {
    object: "list",
    page: 1,
    limit: 1,
    has_more: true,
    total_count: totalCount,
    data: [memberRow("m1")],
  };
}

/** A Style B bookings page with an overridden meta.totalCount. */
function bookingsCountPage(totalCount: number): unknown {
  const sample = loadSample("bookings.get.limit3.json") as {
    data: unknown[];
    success: boolean;
    meta: { totalCount: number; page: number; limit: number };
  };
  return {
    data: [clone(sample.data[0])],
    success: true,
    meta: { totalCount, page: 1, limit: 1 },
  };
}

/** A StripeCharge-wrapped detail row with identity, status, amount overridden. */
function charge(id: string, status: string, amount: number): Record<string, unknown> {
  const detail = stripeChargeRow(id);
  const inner = detail["StripeCharge"] as Record<string, unknown>;
  inner["transaction_status"] = status;
  inner["amount"] = amount;
  return detail;
}

/** The fake pool responder for the Kelo-side counts, keyed by query text. */
function keloCounts(counts: {
  people?: number;
  membersActive?: number;
  bookings?: number;
  transactions?: { rows: unknown[] };
}) {
  return (text: string) => {
    if (text.includes("count(distinct person_external_ref)")) {
      return { rows: [{ n: counts.membersActive ?? 0 }] };
    }
    if (text.includes("from public.people")) return { rows: [{ n: counts.people ?? 0 }] };
    if (text.includes("from public.glofox_bookings")) return { rows: [{ n: counts.bookings ?? 0 }] };
    if (text.includes("from public.glofox_transactions")) {
      return counts.transactions ?? { rows: [] };
    }
    return undefined;
  };
}

/** Reconciliations insert values are positional; read them by name. */
function reconRow(call: { values: readonly unknown[] | undefined }) {
  const v = call.values ?? [];
  return {
    tenantId: v[0],
    entity: v[1],
    windowStart: v[2],
    windowEnd: v[3],
    glofoxCount: v[4],
    keloCount: v[5],
    glofoxSum: v[6],
    keloSum: v[7],
    driftCount: v[8],
    driftSum: v[9],
    status: v[10],
    detail: JSON.parse(String(v[11])) as Record<string, unknown>,
    checkedAt: v[12],
  };
}

describe("members reconciliation — match vs drift", () => {
  it("equal counts write a 'match' row and NO alert", async () => {
    const pool = createFakePool({ respond: keloCounts({ people: 7 }) });
    const client = createFakeClient(() => membersCountPage(7));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["members"] } }),
    );

    expect(outcomes).toEqual([
      {
        entity: "members",
        status: "match",
        glofoxCount: 7,
        keloCount: 7,
        driftCount: 0,
        driftSum: null,
      },
    ]);
    const rows = callsMatching(pool.calls, "insert into public.reconciliations");
    expect(rows).toHaveLength(1);
    const row = reconRow(rows[0]!);
    expect(row.tenantId).toBe(TENANT);
    expect(row.entity).toBe("members");
    expect(row.status).toBe("match");
    expect(row.driftCount).toBe(0);
    expect(row.checkedAt).toBe(NOW.toISOString());
    // The count-only read: page 1, limit 1, the ACTIVE population both sides.
    expect(client.calls[0]?.path).toContain("/2.0/members");
    expect(client.calls[0]?.path).toContain("limit=1");
    expect(client.calls[0]?.path).toContain("active=true");
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
  });

  it("kelo < glofox writes a 'drift' row and opens the 'reconciliation_drift' alert", async () => {
    const pool = createFakePool({ respond: keloCounts({ people: 7 }) });
    const client = createFakeClient(() => membersCountPage(10));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["members"] } }),
    );

    expect(outcomes[0]?.status).toBe("drift");
    expect(outcomes[0]?.driftCount).toBe(3);
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.status).toBe("drift");
    expect(row.glofoxCount).toBe(10);
    expect(row.keloCount).toBe(7);
    expect(row.driftCount).toBe(3);

    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("reconciliation_drift");
    expect(alerts[0]?.values?.[2]).toBe("warning"); // any nonzero drift → warning
    expect(alerts[0]?.values?.[5]).toBe("members"); // deduped per tenant+entity
    // The drift alert OPENS OR REFRESHES (keeps the latest numbers visible).
    expect(alerts[0]?.text).toContain("do update set severity");
  });

  it("drift past the configurable critical threshold escalates the alert", async () => {
    const pool = createFakePool({ respond: keloCounts({ people: 7 }) });
    const client = createFakeClient(() => membersCountPage(10));

    await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["members"], driftCriticalCount: 2 } }),
    );

    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts[0]?.values?.[2]).toBe("critical");
  });
});

describe("members_active canary — the phase-1 single-sided proxy", () => {
  it("records kelo_count only (glofox_count NULL), status 'match', ~23 surfaced not asserted", async () => {
    const pool = createFakePool({ respond: keloCounts({ membersActive: 23 }) });
    const client = createFakeClient(() => {
      throw new Error("the canary must NOT call Glofox");
    });

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["members_active"] } }),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("match");
    expect(outcomes[0]?.glofoxCount).toBeNull();
    expect(outcomes[0]?.keloCount).toBe(23);

    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.entity).toBe("members_active");
    expect(row.glofoxCount).toBeNull();
    expect(row.keloCount).toBe(23);
    expect(row.driftCount).toBeNull();
    expect(row.status).toBe("match");
    // The trailing-45-day window is recorded on the row.
    expect(row.windowEnd).toBe(NOW.toISOString());
    expect(row.windowStart).toBe(new Date(NOW.getTime() - 45 * DAY_MS).toISOString());
    // The proxy rule + the owner's ground truth are documented in detail —
    // surfaced, NEVER hardcoded as a pass/fail assertion.
    expect(row.detail["phase_1_proxy"]).toBe(true);
    expect(String(row.detail["rule"])).toContain("subscription_payment");
    expect(String(row.detail["owner_ground_truth"])).toContain("~23");
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
  });
});

describe("transactions — the money reconciliation (negative branch)", () => {
  const windowStart = new Date(NOW.getTime() - 30 * DAY_MS);

  it("net PAID+REFUNDED both sides: drift in count and sum → 'drift' row + alert", async () => {
    const pool = createFakePool({
      respond: keloCounts({
        transactions: {
          rows: [
            { status: "PAID", n: 1, total: 100 },
            { status: "REFUNDED", n: 1, total: 30 },
          ],
        },
      }),
    });
    const client = createFakeClient(() =>
      reportPage([
        charge("t1", "PAID", 100),
        charge("t2", "PAID", 50),
        charge("t3", "REFUNDED", 30),
        charge("t4", "ERROR", 75), // failed payment — excluded from the net BOTH sides
      ]),
    );

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["transactions"] } }),
    );

    // Glofox net: count 3 (2 PAID + 1 REFUNDED), sum 100+50−30 = 120.
    // Kelo net:   count 2, sum 100−30 = 70. Drift: count 1, sum 50.
    expect(outcomes[0]?.status).toBe("drift");
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.entity).toBe("transactions");
    expect(row.windowStart).toBe(windowStart.toISOString());
    expect(row.windowEnd).toBe(NOW.toISOString());
    expect(row.glofoxCount).toBe(3);
    expect(row.keloCount).toBe(2);
    expect(row.glofoxSum).toBe(120);
    expect(row.keloSum).toBe(70);
    expect(row.driftCount).toBe(1);
    expect(row.driftSum).toBe(50);
    expect(row.status).toBe("drift");
    expect((row.detail["glofox_by_status"] as Record<string, unknown>)["ERROR"]).toBeDefined();
    expect((row.detail["kelo_by_status"] as Record<string, unknown>)["PAID"]).toBeDefined();

    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("reconciliation_drift");
    expect(alerts[0]?.values?.[2]).toBe("warning"); // any nonzero money drift → warning
  });

  it("identical nets write a 'match' row; the report request carries branch + namespace + window", async () => {
    const pool = createFakePool({
      respond: keloCounts({
        transactions: { rows: [{ status: "PAID", n: 2, total: 150 }] },
      }),
    });
    const client = createFakeClient(() =>
      reportPage([charge("t1", "PAID", 100), charge("t2", "PAID", 50)]),
    );

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["transactions"] } }),
    );

    expect(outcomes[0]?.status).toBe("match");
    const report = client.calls.find((c) => c.path.startsWith("/Analytics/report"));
    expect(report?.init?.method).toBe("POST");
    const body = report?.init?.body as Record<string, unknown>;
    expect(body["branch_id"]).toBe("test-branch-id");
    expect(body["namespace"]).toBe("test-namespace"); // trap 2 guard
    expect(body["start"]).toBe(String(Math.floor(windowStart.getTime() / 1000)));
    expect(body["end"]).toBe(String(Math.floor(NOW.getTime() / 1000)));
  });

  it("payload.windowDays overrides the default trailing-30-days window", async () => {
    const pool = createFakePool({ respond: keloCounts({ transactions: { rows: [] } }) });
    const client = createFakeClient(() => reportPage([]));

    await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["transactions"], windowDays: 7 } }),
    );

    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.windowStart).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
    expect(row.detail["window_days"]).toBe(7);
  });
});

describe("error isolation — one entity's failure never blinds the others", () => {
  it("a failing entity writes an 'error' row + alert; the next entity still reconciles", async () => {
    const pool = createFakePool({ respond: keloCounts({ bookings: 42 }) });
    const client = createFakeClient((path) => {
      if (path.startsWith("/2.0/members")) throw new Error("glofox is down");
      return bookingsCountPage(42);
    });

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["members", "bookings"] } }),
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ entity: "members", status: "error" });
    expect(outcomes[1]).toMatchObject({ entity: "bookings", status: "match", driftCount: 0 });

    const rows = callsMatching(pool.calls, "insert into public.reconciliations");
    expect(rows).toHaveLength(2);
    const errorRow = reconRow(rows[0]!);
    expect(errorRow.status).toBe("error");
    expect(String(errorRow.detail["error"])).toContain("glofox is down");
    expect(reconRow(rows[1]!).status).toBe("match");

    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("reconciliation_error");
    expect(alerts[0]?.values?.[2]).toBe("warning");
    expect(alerts[0]?.values?.[5]).toBe("members");
  });

  it("a missing namespace errors the transactions entity loudly (trap 2), not silently empty", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => reportPage([]));
    const ctx = makeCtx({ payload: { entities: ["transactions"] } });

    const outcomes = await runReconciliation(pool, client, {
      ...ctx,
      namespace: undefined,
    });

    expect(outcomes[0]?.status).toBe("error");
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(String(row.detail["error"])).toContain("namespace");
  });
});
