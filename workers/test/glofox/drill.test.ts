import { describe, expect, it } from "vitest";
import { runEntitySync } from "../../src/glofox/pipeline.js";
import { membersSpec } from "../../src/glofox/entities/members.js";
import { runReconciliation } from "../../src/glofox/reconcile/reconcile.js";
import {
  callsMatching,
  createFakeClient,
  createFakePool,
  makeCtx,
  memberRow,
  styleAPage,
} from "./helpers.js";

/**
 * THE KILL-THE-IMPORT DRILL — the phase-1 GATE evidence (plan-final §4 "The
 * five in-system freshness tripwires"; the phase-1 gate: "kill-the-import
 * drill fires all five named in-system tripwires").
 *
 * The historical killer was a 10-week SILENT import freeze. This suite drives
 * the sync pipeline (1.4) + the reconciliation engine (1.5) through the
 * failure modes with a mocked pool + client and asserts each tripwire's
 * OBSERVABLE artifact — the sync_state values, the alert rows, the
 * reconciliations row. Together with the external dead-man heartbeat (the
 * sixth, out-of-system tripwire, proven separately in phase 0), this is the
 * six-tripwire defense: all six must fail simultaneously for another silent
 * freeze.
 */
describe("kill-the-import drill — the five in-system tripwires", () => {
  it("tripwire 1 — watermark law: a schema-invalid (envelope-throw) run does NOT advance committed_watermark", async () => {
    const pool = createFakePool();
    // The envelope is garbage: extractStyleARows throws → the run is
    // schema-invalid → the watermark law blocks committed advancement.
    const client = createFakeClient(() => ({ bogus: "not-an-envelope" }));

    await expect(runEntitySync(pool, client, makeCtx(), membersSpec)).rejects.toThrow();

    // THE LAW: committed_watermark never moved.
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
    // The failure is RECORDED + LOUD: sync_runs 'error', health_state 'error',
    // a 'sync_failed' warning alert (deduped per tenant+entity).
    const closed = callsMatching(pool.calls, "update public.sync_runs");
    expect(closed[0]?.values?.[1]).toBe("error");
    expect(callsMatching(pool.calls, "health_state = 'error'")).toHaveLength(1);
    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("sync_failed");
    // The raw zone still has the evidence page (raw BEFORE parse, always).
    expect(callsMatching(pool.calls, "insert into public.glofox_raw")).toHaveLength(1);
  });

  it("tripwire 2 — plausible-zero config: a zero-row run on a plausible_zero=false entity is 'empty_suspect', no advance", async () => {
    // Default fake state: plausible_zero=false (members — an empty window is
    // how the silent freeze looked). consecutive_empty stays BELOW threshold.
    const pool = createFakePool({ consecutiveEmpty: 1 });
    const client = createFakeClient(() => styleAPage([])); // valid envelope, ZERO rows

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("empty_suspect");
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
    expect(
      callsMatching(pool.calls, "consecutive_empty = consecutive_empty + 1"),
    ).toHaveLength(1);
    expect(callsMatching(pool.calls, "update public.sync_runs")[0]?.values?.[1]).toBe(
      "empty_suspect",
    );
    // Under the alarm threshold: recorded, but not yet the critical alarm.
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
  });

  it("tripwire 3 — consecutive_empty alarm: N=threshold consecutive empty runs open the critical 'sync_empty_suspect' alert", async () => {
    // A stateful fake: consecutive_empty really counts up run over run, like
    // the production row would. Threshold is the default 3.
    let consecutive = 0;
    const pool = createFakePool({
      respond: (text) => {
        if (text.includes("returning consecutive_empty")) {
          consecutive += 1;
          return { rows: [{ consecutive_empty: consecutive }] };
        }
        return undefined;
      },
    });
    const client = createFakeClient(() => styleAPage([]));

    const N = 3; // empty_alarm_threshold
    for (let run = 0; run < N; run += 1) {
      const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);
      expect(outcome.status).toBe("empty_suspect");
      expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
    }

    // The Nth consecutive empty run crosses the threshold → ONE critical alert.
    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("sync_empty_suspect");
    expect(alerts[0]?.values?.[2]).toBe("critical");
    expect(String(alerts[0]?.values?.[3])).toContain(`${N} runs in a row`);
  });

  it("tripwire 4 — expected_min_records baseline: a full run below the floor alerts 'sync_below_expected_min'", async () => {
    // First-ever run (committed null → FULL backfill for tripwire 4) with a
    // configured floor of 100 — the fetch brings back 2.
    const pool = createFakePool({ syncState: { expected_min_records: 100 } });
    const client = createFakeClient(() => styleAPage([memberRow("m1"), memberRow("m2")]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    // Below-floor is VISIBLE but non-blocking: the run still succeeds and the
    // watermark still advances (only ever to the candidate).
    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(2);
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(1);
    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("sync_below_expected_min");
    expect(alerts[0]?.values?.[2]).toBe("warning");
    expect(String(alerts[0]?.values?.[3])).toContain("expected ≥ 100");
  });

  it("tripwire 5 — reconciliation drift: kelo < glofox writes a 'drift' reconciliations row + a 'reconciliation_drift' alert", async () => {
    // Glofox says 10 active members; Kelo imported 7. Drift is LOUD.
    const pool = createFakePool({
      respond: (text) => {
        if (text.includes("from public.people")) return { rows: [{ n: 7 }] };
        return undefined;
      },
    });
    const client = createFakeClient(() => ({
      object: "list",
      page: 1,
      limit: 1,
      has_more: true,
      total_count: 10,
      data: [memberRow("m1")],
    }));

    const outcomes = await runReconciliation(
      pool,
      client,
      makeCtx({ payload: { entities: ["members"] } }),
    );

    expect(outcomes[0]?.status).toBe("drift");
    const rows = callsMatching(pool.calls, "insert into public.reconciliations");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values?.[1]).toBe("members"); // entity
    expect(rows[0]?.values?.[8]).toBe(3); // drift_count = glofox 10 − kelo 7
    expect(rows[0]?.values?.[10]).toBe("drift"); // status
    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("reconciliation_drift");
    expect(alerts[0]?.values?.[5]).toBe("members"); // deduped per tenant+entity
  });
});
