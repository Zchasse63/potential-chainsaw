import { describe, expect, it } from "vitest";
import { runEntitySync } from "../../src/glofox/pipeline.js";
import { createCreditsSpec } from "../../src/glofox/entities/credits.js";
import { bookingsSpec } from "../../src/glofox/entities/bookings.js";
import { membershipsSpec } from "../../src/glofox/entities/memberships.js";
import {
  callsMatching,
  clone,
  createFakeClient,
  createFakePool,
  loadSample,
  makeCtx,
  styleAPage,
} from "./helpers.js";

/**
 * Entity-spec specifics: kelo_type ownership, credit debit dedupe, the
 * timezone fallback chain, credits chunking.
 */

describe("memberships upsert — kelo_type is owner-owned", () => {
  it("the DO UPDATE SET never touches kelo_type (asserted on the SQL itself)", async () => {
    const pool = createFakePool();
    const sample = loadSample("memberships.get.json") as { data: unknown[] };
    const client = createFakeClient(() => styleAPage(clone(sample.data)));

    const outcome = await runEntitySync(pool, client, makeCtx(), membershipsSpec);

    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(6); // 6 pinned catalog items
    const upserts = callsMatching(pool.calls, "insert into public.plan_catalog");
    expect(upserts.length).toBeGreaterThan(0);
    for (const call of upserts) {
      expect(call.text).toContain("on conflict (tenant_id, external_ref, plan_code)");
      expect(call.text).not.toContain("kelo_type = excluded.kelo_type");
      // kelo_type appears only in the INSERT column list (first-sight NULL) —
      // strip SQL comments before scanning the SET clause.
      const uncommented = call.text.replace(/--[^\n]*/g, "");
      const setClause = uncommented.split("do update set")[1] ?? "";
      expect(setClause).not.toContain("kelo_type");
    }
  });

  it("fetches public and private pages, dedupes overlap, and upserts a private item", async () => {
    const sample = loadSample("memberships.get.json") as { data: Record<string, unknown>[] };
    const publicItem = clone(sample.data[0]!);
    const privateItem = clone(sample.data[0]!);
    privateItem["_id"] = "private-partner-plan";
    privateItem["name"] = "Private Partner Plan";
    const plans = privateItem["plans"] as Record<string, unknown>[];
    plans[0]!["code"] = 900000001;
    plans[0]!["name"] = "Private Partner Plan";

    const pool = createFakePool();
    const client = createFakeClient((path) =>
      path.includes("private=true")
        ? styleAPage([clone(publicItem), privateItem])
        : styleAPage([publicItem]),
    );

    const outcome = await runEntitySync(pool, client, makeCtx(), membershipsSpec);

    expect(outcome.status).toBe("success");
    expect(outcome.rowsFetched).toBe(2);
    expect(client.calls.map((call) => call.path)).toEqual([
      "/2.0/memberships?page=1&limit=100",
      "/2.0/memberships?private=true&page=1&limit=100",
    ]);
    const upserts = callsMatching(pool.calls, "insert into public.plan_catalog");
    expect(upserts).toHaveLength(2);
    expect(upserts.some((call) => call.values?.[1] === "private-partner-plan")).toBe(true);
  });
});

describe("credits — debit dedupe rule", () => {
  function creditPack(id: string, userId: string, granted: number, available: number): unknown {
    const sample = loadSample("credits.get.nonempty.json") as { data: unknown[] };
    const pack = clone(sample.data[0]) as Record<string, unknown>;
    pack["_id"] = id;
    pack["user_id"] = userId;
    pack["num_sessions"] = granted;
    pack["available"] = available;
    // Exact attribution: bookings.length must equal granted − available.
    pack["bookings"] = Array.from({ length: granted - available }, (_, i) => `${id}-b${i}`);
    // RAW (not pre-parsed): the sync layer strict-parses at its own boundary.
    return pack;
  }

  function membersChunk(refs: string[]): { rows: unknown[] } {
    return { rows: refs.map((ref, i) => ({ id: `person-${i}`, external_ref: ref })) };
  }

  function creditsPool(coverageByCreditId: Record<string, number>, memberRefs: string[]) {
    return createFakePool({
      syncState: { plausible_zero: true },
      respond: (text, values) => {
        if (text.includes("from public.people")) return membersChunk(memberRefs);
        if (text.includes("select id from public.credit_ledger")) {
          return { rows: [{ id: `grant-${String(values?.[1])}` }] };
        }
        if (text.includes("as coverage")) {
          const grantId = String(values?.[1]); // "grant-<creditId>"
          return { rows: [{ coverage: coverageByCreditId[grantId.replace(/^grant-/, "")] ?? 0 }] };
        }
        return undefined;
      },
    });
  }

  it("first observed consumption (coverage 0) inserts the mapper's per-booking debits verbatim", async () => {
    const pack = creditPack("c1", "u1", 10, 7); // consumed 3
    const pool = creditsPool({ c1: 0 }, ["u1"]);
    const client = createFakeClient(() => styleAPage([pack]));

    const outcome = await runEntitySync(pool, client, makeCtx(), createCreditsSpec());

    expect(outcome.status).toBe("success");
    const grants = callsMatching(pool.calls, "values ($1,$2,'grant'");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.text).toContain("do nothing");
    const debits = callsMatching(pool.calls, "values ($1,$2,'debit'");
    expect(debits).toHaveLength(3);
    for (const [i, debit] of debits.entries()) {
      expect(debit.values?.[2]).toBe(-1);
      expect(debit.values?.[4]).toBe(`c1-b${i}`); // booking_external_ref
    }
    // The per-grant advisory lock serialized the check-then-insert.
    expect(callsMatching(pool.calls, "pg_advisory_xact_lock")).toHaveLength(1);
  });

  it("coverage ≥ consumed inserts NO debits (idempotent re-import)", async () => {
    const pack = creditPack("c1", "u1", 10, 7); // consumed 3, covered 3
    const pool = creditsPool({ c1: 3 }, ["u1"]);
    const client = createFakeClient(() => styleAPage([pack]));

    await runEntitySync(pool, client, makeCtx(), createCreditsSpec());

    expect(callsMatching(pool.calls, "values ($1,$2,'grant'")).toHaveLength(1); // grant still idempotent
    expect(callsMatching(pool.calls, "values ($1,$2,'debit'")).toHaveLength(0);
  });

  it("0 < coverage < consumed inserts ONE top-up debit of −(consumed − coverage)", async () => {
    const pack = creditPack("c1", "u1", 10, 2); // consumed 8, covered 3
    const pool = creditsPool({ c1: 3 }, ["u1"]);
    const client = createFakeClient(() => styleAPage([pack]));

    await runEntitySync(pool, client, makeCtx(), createCreditsSpec());

    const debits = callsMatching(pool.calls, "values ($1,$2,'debit'");
    expect(debits).toHaveLength(1);
    expect(debits[0]?.values?.[2]).toBe(-5);
    expect(debits[0]?.values?.[4]).toBeNull(); // booking_external_ref
    expect(String(debits[0]?.values?.[5])).toContain("top-up debit: consumed rose 3 → 8");
  });

  it("a full 500-member chunk re-enqueues the next chunk with the cursor in the payload", async () => {
    const refs = Array.from({ length: 500 }, (_, i) => `u${String(i).padStart(4, "0")}`);
    const pool = createFakePool({
      syncState: { plausible_zero: true },
      respond: (text) => {
        if (text.includes("from public.people")) {
          return { rows: refs.map((ref, i) => ({ id: `person-${i}`, external_ref: ref })) };
        }
        return undefined;
      },
    });
    const client = createFakeClient(() => styleAPage([])); // no packs anywhere

    const outcome = await runEntitySync(pool, client, makeCtx(), createCreditsSpec());

    expect(outcome.status).toBe("success");
    expect(client.calls).toHaveLength(500); // one per member
    const enqueue = callsMatching(pool.calls, "app.enqueue_job");
    expect(enqueue).toHaveLength(1);
    expect(enqueue[0]?.values?.[0]).toBe("glofox.sync.credits");
    expect(JSON.parse(String(enqueue[0]?.values?.[1]))).toEqual({ cursor: "u0499" });
    expect(enqueue[0]?.values?.[3]).toContain("glofox.sync.credits:");
    expect(enqueue[0]?.values?.[3]).toContain("u0499");
  });

  it("a partial chunk does NOT re-enqueue (the pass is done)", async () => {
    const pool = creditsPool({}, ["u1", "u2"]);
    const client = createFakeClient(() => styleAPage([]));

    await runEntitySync(pool, client, makeCtx(), createCreditsSpec());

    expect(callsMatching(pool.calls, "app.enqueue_job")).toHaveLength(0);
  });

  it("resumes from the payload cursor (external_ref > cursor)", async () => {
    const pool = creditsPool({}, ["u2"]);
    const client = createFakeClient(() => styleAPage([]));

    await runEntitySync(pool, client, makeCtx({ payload: { cursor: "u1" } }), createCreditsSpec());

    const select = callsMatching(pool.calls, "from public.people")[0];
    expect(select?.values?.[1]).toBe("u1");
  });
});

describe("bookings timezone resolution", () => {
  it("falls back to branch.get() (with a warning) when no locations row exists", async () => {
    const pool = createFakePool({
      respond: (text) => {
        if (text.includes("from public.locations")) return { rows: [] };
        return undefined;
      },
    });
    let branchGetCalls = 0;
    const sample = loadSample("bookings.get.limit3.json") as { data: unknown[] };
    const styleBPage = {
      data: [clone(sample.data[0])],
      success: true,
      meta: { totalCount: 1, page: 1, limit: 100 },
    };
    const client = createFakeClient(() => styleBPage, {
      branchGet: async () => {
        branchGetCalls += 1;
        return { address: { timezone_id: "America/New_York" } };
      },
    });

    const outcome = await runEntitySync(pool, client, makeCtx(), bookingsSpec);

    expect(outcome.status).toBe("success");
    expect(branchGetCalls).toBe(1);
    expect(callsMatching(pool.calls, "insert into public.glofox_bookings")).toHaveLength(1);
  });
});
