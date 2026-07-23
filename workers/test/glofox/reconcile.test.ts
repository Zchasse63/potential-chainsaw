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
  // LIVE FINDING (2026-07-18): meta.totalCount is untrustworthy — the counter
  // now paginates and counts DATA ROWS, so the fake emits N real rows (< 100,
  // ending pagination after one page). meta.totalCount is deliberately wrong
  // here to prove the counter never reads it.
  return {
    data: Array.from({ length: totalCount }, () => clone(sample.data[0])),
    success: true,
    meta: { totalCount: 2, page: 1, limit: 100 },
  };
}

/** The fake pool responder for the Kelo-side counts, keyed by query text. */
function keloCounts(counts: {
  people?: number;
  membersActive?: number;
  bookings?: number;
  softDeletedBookings?: number;
  transactions?: { rows: unknown[] };
}) {
  return (text: string) => {
    // The canary now counts the AUTHORITATIVE derived cohort (certified
    // 22/22); route it BEFORE the generic people-count branch.
    if (text.includes("primary_relationship = 'recurring_member'")) {
      return { rows: [{ n: counts.membersActive ?? 0 }] };
    }
    if (text.includes("count(distinct person_external_ref)")) {
      return { rows: [{ n: counts.membersActive ?? 0 }] };
    }
    if (text.includes("from public.people")) return { rows: [{ n: counts.people ?? 0 }] };
    if (text.includes("from public.glofox_bookings") && text.includes("deleted_at is not null")) {
      return { rows: [{ n: counts.softDeletedBookings ?? 0 }] };
    }
    if (text.includes("from public.glofox_bookings"))
      return { rows: [{ n: counts.bookings ?? 0 }] };
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

describe("transactions — boundary-aware ID set reconciliation", () => {
  const windowStart = new Date(NOW.getTime() - 30 * DAY_MS);

  it("identical ID sets write a match and request the exact report window", async () => {
    const pool = createFakePool({
      respond: keloCounts({
        transactions: {
          rows: [
            { external_ref: "t1", transaction_created_at: "2026-07-10T12:00:00.000Z" },
            { external_ref: "t2", transaction_created_at: "2026-07-11T12:00:00.000Z" },
          ],
        },
      }),
    });
    const client = createFakeClient(() =>
      reportPage([stripeChargeRow("t1"), stripeChargeRow("t2")]),
    );

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["transactions"] } }),
    );

    expect(outcomes[0]).toMatchObject({
      status: "match",
      glofoxCount: 2,
      keloCount: 2,
      driftCount: 0,
      driftSum: null,
    });
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.detail["only_in_glofox"]).toEqual([]);
    expect(row.detail["only_in_kelo"]).toEqual([]);
    expect(row.detail["boundary_rows"]).toBe(0);
    const report = client.calls.find((c) => c.path.startsWith("/Analytics/report"));
    expect(report?.init?.method).toBe("POST");
    const body = report?.init?.body as Record<string, unknown>;
    expect(body["branch_id"]).toBe("test-branch-id");
    expect(body["namespace"]).toBe("test-namespace"); // trap 2 guard
    expect(body["start"]).toBe(String(Math.floor(windowStart.getTime() / 1000)));
    expect(body["end"]).toBe(String(Math.floor(NOW.getTime() / 1000)));
    const keloRead = callsMatching(pool.calls, "select external_ref, transaction_created_at")[0]!;
    expect(keloRead.values?.[1]).toBe(new Date(windowStart.getTime() - DAY_MS).toISOString());
    expect(keloRead.values?.[2]).toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
    expect(keloRead.values?.[3]).toEqual(["t1", "t2"]);
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
  });

  it("a report ID whose UTC conversion falls over the edge is an explained match", async () => {
    const pool = createFakePool({
      respond: keloCounts({
        transactions: {
          rows: [
            {
              external_ref: "edge-id",
              transaction_created_at: new Date(windowStart.getTime() - 4 * 60 * 60 * 1000),
            },
          ],
        },
      }),
    });
    const client = createFakeClient(() => reportPage([stripeChargeRow("edge-id")]));

    await runReconciliation(pool, client, makeCtx({ payload: { entities: ["transactions"] } }));

    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.glofoxCount).toBe(1);
    expect(row.keloCount).toBe(0);
    expect(row.driftCount).toBe(0);
    expect(row.status).toBe("match");
    expect(row.detail["only_in_glofox"]).toEqual([]);
    expect(row.detail["only_in_kelo"]).toEqual([]);
    expect(row.detail["boundary_rows"]).toBe(1);
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
  });

  it("a genuinely absent report ID is positive drift and is listed by ID only", async () => {
    const pool = createFakePool({
      respond: keloCounts({ transactions: { rows: [] } }),
    });
    const client = createFakeClient(() => reportPage([stripeChargeRow("missing-id")]));

    await runReconciliation(pool, client, makeCtx({ payload: { entities: ["transactions"] } }));

    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.driftCount).toBe(1);
    expect(row.status).toBe("drift");
    expect(row.detail["only_in_glofox"]).toEqual(["missing-id"]);
    expect(row.detail["only_in_kelo"]).toEqual([]);
    expect(row.detail["boundary_rows"]).toBe(0);
  });

  it("a Kelo-only interior ID preserves negative signed drift", async () => {
    const pool = createFakePool({
      respond: keloCounts({
        transactions: {
          rows: [{ external_ref: "kelo-only", transaction_created_at: "2026-07-10T12:00:00.000Z" }],
        },
      }),
    });
    const client = createFakeClient(() => reportPage([]));

    await runReconciliation(pool, client, makeCtx({ payload: { entities: ["transactions"] } }));

    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.driftCount).toBe(-1);
    expect(row.status).toBe("drift");
    expect(row.detail["only_in_glofox"]).toEqual([]);
    expect(row.detail["only_in_kelo"]).toEqual(["kelo-only"]);
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

describe("bookings — active facts only", () => {
  it("excludes soft-deleted rows and reports their retained count", async () => {
    const pool = createFakePool({
      respond: keloCounts({ bookings: 3, softDeletedBookings: 6 }),
    });
    const client = createFakeClient(() => bookingsCountPage(3));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["bookings"] } }),
    );

    expect(outcomes[0]).toMatchObject({
      entity: "bookings",
      status: "match",
      glofoxCount: 3,
      keloCount: 3,
      driftCount: 0,
    });
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.detail["soft_deleted"]).toBe(6);
    expect(String(row.detail["kelo_source"])).toContain("deleted_at is null");
    expect(callsMatching(pool.calls, "deleted_at is null")).toHaveLength(1);
    expect(callsMatching(pool.calls, "deleted_at is not null")).toHaveLength(1);
  });
});

/** The single-round-trip credits conservation row (raw zone vs ledger). */
function creditsRow(row: {
  packs: number;
  raw_granted: number;
  raw_outstanding: number;
  grants: number;
  ledger_granted: number;
  net_balance: number;
  open_q: number;
  mismatches: number;
}) {
  return (text: string) =>
    text.includes("endpoint = '/2.0/credits'") ? { rows: [row] } : undefined;
}

describe("credits — DB-only raw→ledger conservation (the standing-gap backstop)", () => {
  it("ledger at parity with the raw zone reports match, no drift alert", async () => {
    const pool = createFakePool({
      respond: creditsRow({
        packs: 307,
        raw_granted: 1907,
        raw_outstanding: 1199,
        grants: 307,
        ledger_granted: 1907,
        net_balance: 1199,
        open_q: 0,
        mismatches: 0,
      }),
    });
    const client = createFakeClient(() => ({}));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["credits"] } }),
    );

    expect(outcomes[0]).toMatchObject({
      entity: "credits",
      status: "match",
      glofoxCount: 307,
      keloCount: 307,
      driftCount: 0,
      driftSum: 0,
    });
    // DB-only: it must NEVER touch the Glofox client for credits.
    expect(client.calls).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.detail["per_person_balance_mismatches"]).toBe(0);
  });

  it("a standing gap (missing grants + understated balance) drifts and opens the alert", async () => {
    // The 2026-07-22 shape: 41 packs never made it to the ledger, so 331
    // outstanding credits are unaccounted for.
    const pool = createFakePool({
      respond: creditsRow({
        packs: 307,
        raw_granted: 1907,
        raw_outstanding: 1199,
        grants: 266,
        ledger_granted: 1576,
        net_balance: 868,
        open_q: 5,
        mismatches: 41,
      }),
    });
    const client = createFakeClient(() => ({}));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["credits"] } }),
    );

    expect(outcomes[0]).toMatchObject({
      entity: "credits",
      status: "drift",
      driftCount: 41, // 307 raw packs − 266 ledger grants
      driftSum: 331, // 1199 raw outstanding − 868 ledger balance
    });
    const alert = callsMatching(pool.calls, "insert into public.alerts");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.values?.[1]).toBe("reconciliation_drift");
    expect(alert[0]?.values?.[2]).toBe("critical"); // 331 > $100 floor and 41 > 10 count
    expect(alert[0]?.values?.[5]).toBe("credits");
    const row = reconRow(callsMatching(pool.calls, "insert into public.reconciliations")[0]!);
    expect(row.detail["per_person_balance_mismatches"]).toBe(41);
    expect(row.detail["open_quarantine"]).toBe(5);
  });

  it("a per-person balance mismatch drifts even when counts and totals net out", async () => {
    // packs == grants and totals equal, but one person's raw balance != ledger:
    // an offsetting error that count/total checks alone would miss.
    const pool = createFakePool({
      respond: creditsRow({
        packs: 307,
        raw_granted: 1907,
        raw_outstanding: 1199,
        grants: 307,
        ledger_granted: 1907,
        net_balance: 1199,
        open_q: 0,
        mismatches: 2,
      }),
    });
    const client = createFakeClient(() => ({}));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["credits"] } }),
    );

    expect(outcomes[0]).toMatchObject({ entity: "credits", status: "drift", driftCount: 0, driftSum: 0 });
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(1);
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
