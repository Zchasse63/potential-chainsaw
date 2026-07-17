import { describe, expect, it } from "vitest";
import { GlofoxAuthError, GlofoxHttpError } from "@kelo/glofox";
import { runEntitySync } from "../../src/glofox/pipeline.js";
import { membersSpec } from "../../src/glofox/entities/members.js";
import {
  callsMatching,
  createFakeClient,
  createFakePool,
  firstIndex,
  makeCtx,
  memberRow,
  NOW,
  styleAPage,
  TENANT,
} from "./helpers.js";

/**
 * THE WATERMARK LAW + the freshness tripwires (plan-final §4). These tests are
 * the product: the historical killer was a silent import freeze.
 */

describe("watermark law (tripwire 1)", () => {
  it("a successful run advances committed to the window end and closes 'success'", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => styleAPage([memberRow("m1"), memberRow("m2")]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(2);
    expect(outcome.rowsUpserted).toBe(4); // 2 people + 2 external refs

    // committed_watermark = candidate = the window end (the injected clock).
    const advance = callsMatching(pool.calls, "set committed_watermark");
    expect(advance).toHaveLength(1);
    expect(advance[0]?.values?.[2]).toBe(NOW.toISOString());
    expect(advance[0]?.values?.[3]).toBe(NOW.toISOString()); // last_run_at/last_success_at
    expect(advance[0]?.text).toContain("health_state = 'healthy'");

    const closed = callsMatching(pool.calls, "update public.sync_runs");
    expect(closed[0]?.values?.[1]).toBe("success");
    expect(closed[0]?.values?.[2]).toBe(2); // rows_fetched
  });

  it("an error run advances NO watermark (completed batches keep candidates), alerts, rethrows", async () => {
    const pool = createFakePool();
    let page = 0;
    const client = createFakeClient(() => {
      page += 1;
      if (page === 1) return styleAPage([memberRow("m1")], 1, true); // one good page…
      throw new GlofoxHttpError(500, "/2.0/members", "boom"); // …then the fetch dies
    });

    await expect(runEntitySync(pool, client, makeCtx(), membersSpec)).rejects.toThrow(
      GlofoxHttpError,
    );

    // committed NEVER advanced…
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
    // …but page 1's candidate committed in its own transaction.
    expect(callsMatching(pool.calls, "set candidate_watermark")).toHaveLength(1);

    const stateUpdate = callsMatching(pool.calls, "health_state = 'error'");
    expect(stateUpdate).toHaveLength(1);
    expect(callsMatching(pool.calls, "paused = true")).toHaveLength(0);

    const alert = callsMatching(pool.calls, "insert into public.alerts");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.values?.[1]).toBe("sync_failed");
    expect(alert[0]?.values?.[2]).toBe("warning");
    expect(alert[0]?.values?.[5]).toBe("members"); // dedupe per tenant+entity

    const closed = callsMatching(pool.calls, "update public.sync_runs");
    expect(closed[0]?.values?.[1]).toBe("error");
    expect(closed[0]?.values?.[5]).toContain("boom");
  });

  it("commits the candidate watermark INSIDE the batch transaction", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));
    await runEntitySync(pool, client, makeCtx(), membersSpec);

    const begin = firstIndex(pool.calls, "begin");
    const upsert = firstIndex(pool.calls, "insert into public.people");
    const candidate = firstIndex(pool.calls, "set candidate_watermark");
    const commit = firstIndex(pool.calls, "commit");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(upsert);
    expect(upsert).toBeLessThan(candidate);
    expect(candidate).toBeLessThan(commit);
  });
});

describe("zero-row runs (tripwires 2 + 3)", () => {
  it("plausible_zero=false → 'empty_suspect', consecutive_empty++, NO advance, no alert under threshold", async () => {
    const pool = createFakePool({ consecutiveEmpty: 1 });
    const client = createFakeClient(() => styleAPage([]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("empty_suspect");
    expect(outcome.rowsFetched).toBe(0);
    const increment = callsMatching(pool.calls, "consecutive_empty = consecutive_empty + 1");
    expect(increment).toHaveLength(1);
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
    expect(callsMatching(pool.calls, "update public.sync_runs")[0]?.values?.[1]).toBe(
      "empty_suspect",
    );
  });

  it("crossing empty_alarm_threshold opens the critical 'sync_empty_suspect' alert", async () => {
    const pool = createFakePool({ consecutiveEmpty: 3 });
    const client = createFakeClient(() => styleAPage([]));

    await runEntitySync(pool, client, makeCtx(), membersSpec);

    const alert = callsMatching(pool.calls, "insert into public.alerts");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.values?.[1]).toBe("sync_empty_suspect");
    expect(alert[0]?.values?.[2]).toBe("critical");
    expect(alert[0]?.values?.[5]).toBe("members");
    // Still no watermark advance.
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
  });

  it("plausible_zero=true advances on a zero-row run (success, counter untouched)", async () => {
    const pool = createFakePool({ syncState: { plausible_zero: true } });
    const client = createFakeClient(() => styleAPage([]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("success");
    const advance = callsMatching(pool.calls, "set committed_watermark");
    expect(advance).toHaveLength(1);
    // consecutive_empty is NOT incremented and NOT reset (only non-empty resets):
    // the advance statement carries nonEmpty=false.
    expect(advance[0]?.values?.[4]).toBe(false);
    expect(callsMatching(pool.calls, "consecutive_empty + 1")).toHaveLength(0);
  });

  it("a non-zero success resets consecutive_empty (nonEmpty=true)", async () => {
    const pool = createFakePool({ syncState: { consecutive_empty: 2 } });
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));

    await runEntitySync(pool, client, makeCtx(), membersSpec);

    const advance = callsMatching(pool.calls, "set committed_watermark");
    expect(advance[0]?.values?.[4]).toBe(true); // case when $5 then 0
  });
});

describe("expected_min_records (tripwire 4)", () => {
  it("a full backfill below the floor alerts 'sync_below_expected_min' but still advances", async () => {
    const pool = createFakePool({ syncState: { expected_min_records: 1000 } });
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("success");
    const alert = callsMatching(pool.calls, "insert into public.alerts");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.values?.[1]).toBe("sync_below_expected_min");
    expect(alert[0]?.values?.[2]).toBe("warning");
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(1);
  });
});

describe("per-row salvage (one bad row never kills a page)", () => {
  it("row 2 fails the strict parse → rows 1+3 upserted, row 2 quarantined, run succeeds, watermark advances", async () => {
    const good1 = memberRow("m1");
    const bad = memberRow("m2");
    delete bad["_id"]; // breaks the strict row contract
    const good3 = memberRow("m3");
    const pool = createFakePool();
    const client = createFakeClient(() => styleAPage([good1, bad, good3]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(3);
    expect(outcome.rowsUpserted).toBe(4); // 2 people + 2 refs
    expect(outcome.rowsQuarantined).toBe(1);

    const quarantined = callsMatching(pool.calls, "insert into public.import_quarantine");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.values?.[4]).toContain("row failed contract parse");
    expect(quarantined[0]?.values?.[1]).toBe("members");
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(1);
  });
});

describe("raw-before-parse (step 1)", () => {
  it("the raw zone write precedes any upsert and the batch transaction", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));
    await runEntitySync(pool, client, makeCtx(), membersSpec);

    const raw = firstIndex(pool.calls, "insert into public.glofox_raw");
    const begin = firstIndex(pool.calls, "begin");
    const upsert = firstIndex(pool.calls, "insert into public.people");
    expect(raw).toBeGreaterThanOrEqual(0);
    expect(raw).toBeLessThan(begin);
    expect(raw).toBeLessThan(upsert);

    // Raw row: endpoint, hash-dedup conflict target, sync_run linkage.
    const rawCall = callsMatching(pool.calls, "insert into public.glofox_raw")[0];
    expect(rawCall?.values?.[1]).toBe("/2.0/members");
    expect(rawCall?.text).toContain("on conflict (tenant_id, endpoint, payload_hash) do nothing");
    expect(rawCall?.values?.[5]).toBe("run-1");
  });
});

describe("duplicate email (shared family emails are real)", () => {
  it("23505 on the email index quarantines that row under a savepoint; the batch continues", async () => {
    let peopleInserts = 0;
    const pool = createFakePool({
      respond: (text) => {
        if (text.includes("insert into public.people")) {
          peopleInserts += 1;
          if (peopleInserts === 2) {
            // pg unique_violation on people_tenant_email_key.
            const err = new Error("duplicate key") as Error & {
              code?: string;
              constraint?: string;
            };
            err.code = "23505";
            err.constraint = "people_tenant_email_key";
            throw err;
          }
          return { rows: [{ id: `person-${peopleInserts}` }] };
        }
        return undefined;
      },
    });
    const client = createFakeClient(() =>
      styleAPage([memberRow("m1", "shared@example.com"), memberRow("m2", "shared@example.com")]),
    );

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("success");
    // Person 1 upserted (+ its ref); person 2 quarantined, its ref dropped.
    expect(outcome.rowsUpserted).toBe(2);
    expect(outcome.rowsQuarantined).toBe(1);

    const quarantined = callsMatching(pool.calls, "insert into public.import_quarantine");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.values?.[4]).toBe("duplicate email — merge review");
    expect(quarantined[0]?.values?.[2]).toBe("m2");

    // The savepoint isolated the failure; the transaction still committed.
    expect(callsMatching(pool.calls, "rollback to savepoint person_row")).toHaveLength(1);
    expect(firstIndex(pool.calls, "commit")).toBeGreaterThan(
      firstIndex(pool.calls, "rollback to savepoint person_row"),
    );
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(1);
  });

  it("a NON-email unique violation is not swallowed — the run errors", async () => {
    const pool = createFakePool({
      respond: (text) => {
        if (text.includes("insert into public.people")) {
          const err = new Error("duplicate key") as Error & { code?: string; constraint?: string };
          err.code = "23505";
          err.constraint = "some_other_constraint";
          throw err;
        }
        return undefined;
      },
    });
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));

    await expect(runEntitySync(pool, client, makeCtx(), membersSpec)).rejects.toThrow(
      "duplicate key",
    );
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
  });
});

describe("auth failure (the import-pause signal)", () => {
  it("GlofoxAuthError → paused_auth_failed + paused=true + critical alert + job fails", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => {
      throw new GlofoxAuthError(401, "/2.0/members", "unauthorized");
    });

    await expect(runEntitySync(pool, client, makeCtx(), membersSpec)).rejects.toThrow(
      GlofoxAuthError,
    );

    const pause = callsMatching(pool.calls, "health_state = 'paused_auth_failed'");
    expect(pause).toHaveLength(1);
    expect(pause[0]?.text).toContain("paused = true");

    const alert = callsMatching(pool.calls, "insert into public.alerts");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.values?.[1]).toBe("glofox_auth_failed");
    expect(alert[0]?.values?.[2]).toBe("critical");

    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(0);
    expect(callsMatching(pool.calls, "update public.sync_runs")[0]?.values?.[1]).toBe("error");
  });

  it("a subsequent run while paused=true no-ops: no fetch, no sync_runs row, no writes", async () => {
    const pool = createFakePool({
      syncState: { paused: true, health_state: "paused_auth_failed" },
    });
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));

    const outcome = await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(outcome.status).toBe("paused");
    expect(client.calls).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.sync_runs")).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.glofox_raw")).toHaveLength(0);
    expect(callsMatching(pool.calls, "update public.sync_state")).toHaveLength(0);
  });
});

describe("incremental window", () => {
  it("fetches with utc_modified_start_date = committed − 5min overlap guard", async () => {
    const committed = new Date(NOW.getTime() - 60 * 60 * 1000);
    const pool = createFakePool({
      syncState: { committed_watermark: committed.toISOString() },
    });
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));

    await runEntitySync(pool, client, makeCtx(), membersSpec);

    const path = client.calls[0]?.path ?? "";
    const start = Math.floor((committed.getTime() - 5 * 60 * 1000) / 1000);
    const end = Math.floor(NOW.getTime() / 1000);
    expect(path).toContain(`utc_modified_start_date=${start}`);
    expect(path).toContain(`utc_modified_end_date=${end}`);
  });

  it("a null committed watermark means full backfill: no start param", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));

    await runEntitySync(pool, client, makeCtx(), membersSpec);

    expect(client.calls[0]?.path).not.toContain("utc_modified_start_date");
  });
});

describe("tenant scoping", () => {
  it("every sync_state/sync_runs write carries the tenant + entity", async () => {
    const pool = createFakePool();
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));
    await runEntitySync(pool, client, makeCtx(), membersSpec);

    const runInsert = callsMatching(pool.calls, "insert into public.sync_runs")[0];
    expect(runInsert?.values?.[0]).toBe(TENANT);
    expect(runInsert?.values?.[1]).toBe("members");
  });
});
