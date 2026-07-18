import { describe, expect, it } from "vitest";
import { runDeletionDetection } from "../../src/glofox/deletion/deletion.js";
import {
  callsMatching,
  createFakeClient,
  createFakePool,
  firstIndex,
  makeCtx,
  NOW,
  styleAPage,
  TENANT,
} from "./helpers.js";

/**
 * DELETION DETECTION (phase 1 · unit 5 — plan-final §4 step 6). The
 * two-consecutive-snapshot law: first miss → 'candidate', second consecutive
 * miss → 'confirmed', reappearance → resolved, and NOTHING is ever
 * auto-deleted (README §6: soft-delete + reactivation are real).
 *
 * The lenient member envelope keeps rows unknown — plain {_id} objects stand
 * in for members (identity is the only field this unit reads).
 */

function membersClient(pages: Record<string, unknown>[]) {
  let page = 0;
  return createFakeClient(() => {
    const current = pages[Math.min(page, pages.length - 1)]!;
    page += 1;
    return current;
  });
}

function membersCtx() {
  return makeCtx({ payload: { entities: ["members"] } });
}

function bookingsPage(rows: unknown[], page = 1): unknown {
  return {
    data: rows,
    success: true,
    // Deliberately untrustworthy: deletion pagination must use page fullness.
    meta: { totalCount: 2, page, limit: 100 },
  };
}

function refsPool(
  keloRefs: string[],
  previousRefs: string[] | null,
  opts: { resolvedRows?: unknown[] } = {},
) {
  return createFakePool({
    respond: (text) => {
      if (text.includes("from public.import_snapshots")) {
        return previousRefs === null
          ? { rows: [] }
          : { rows: [{ external_refs: previousRefs, snapshot_at: "2026-07-16T23:00:00.000Z" }] };
      }
      if (text.includes("from public.people")) {
        return { rows: keloRefs.map((external_ref) => ({ external_ref })) };
      }
      if (text.includes("update public.deletion_candidates")) {
        return { rows: opts.resolvedRows ?? [] };
      }
      return undefined;
    },
  });
}

describe("the two-consecutive-snapshot law", () => {
  it("a first miss (no previous snapshot) → 'candidate', never 'confirmed'", async () => {
    const pool = refsPool(["a", "b", "c"], null);
    const client = membersClient([styleAPage([{ _id: "a" }, { _id: "b" }])]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    expect(outcomes).toEqual([
      {
        entity: "members",
        status: "ok",
        snapshotRefs: 2,
        newCandidates: 1,
        confirmed: 0,
        resolved: 0,
      },
    ]);

    // The snapshot row: the full ref set + count, inside one transaction.
    const snapshot = callsMatching(pool.calls, "insert into public.import_snapshots");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.values?.[0]).toBe(TENANT);
    expect(snapshot[0]?.values?.[2]).toBe(NOW.toISOString());
    expect(snapshot[0]?.values?.[3]).toEqual(["a", "b"]);
    expect(snapshot[0]?.values?.[4]).toBe(2);
    expect(firstIndex(pool.calls, "begin")).toBeGreaterThanOrEqual(0);
    expect(firstIndex(pool.calls, "begin")).toBeLessThan(
      firstIndex(pool.calls, "insert into public.import_snapshots"),
    );

    // 'c' is missing → a CANDIDATE with first_missing_at, confirmed_missing_at unset.
    const candidates = callsMatching(pool.calls, "insert into public.deletion_candidates");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.values?.[2]).toBe("c");
    expect(candidates[0]?.values?.[3]).toBe(NOW.toISOString()); // first_missing_at
    expect(candidates[0]?.text).toContain("'candidate'");
    expect(candidates[0]?.text).not.toContain("confirmed_missing_at");

    // The fetch used active=any: soft-deleted members stay listed — only true
    // disappearance is deletion evidence.
    expect(client.calls[0]?.path).toContain("active=any");
  });

  it("a second consecutive miss → 'confirmed' with confirmed_missing_at", async () => {
    const pool = refsPool(["a", "b", "c"], ["a", "b"]);
    const client = membersClient([styleAPage([{ _id: "a" }, { _id: "b" }])]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    expect(outcomes[0]?.newCandidates).toBe(0);
    expect(outcomes[0]?.confirmed).toBe(1);
    const candidates = callsMatching(pool.calls, "insert into public.deletion_candidates");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.values?.[2]).toBe("c");
    expect(candidates[0]?.values?.[4]).toBe(NOW.toISOString()); // confirmed_missing_at
    expect(candidates[0]?.text).toContain("'confirmed'");
    expect(String(candidates[0]?.values?.[5])).toContain("TWO consecutive");

    // Confirmed candidates are LOUD (deduped per tenant+entity).
    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("deletion_candidates");
    expect(alerts[0]?.values?.[2]).toBe("warning");
    expect(String(alerts[0]?.values?.[4])).toContain("never auto-deleted");
  });

  it("a miss in the latest snapshot only (present in the prior) stays a 'candidate'", async () => {
    const pool = refsPool(["a", "b", "c"], ["a", "b", "c"]);
    const client = membersClient([styleAPage([{ _id: "a" }, { _id: "b" }])]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    expect(outcomes[0]?.newCandidates).toBe(1);
    expect(outcomes[0]?.confirmed).toBe(0);
    const candidates = callsMatching(pool.calls, "insert into public.deletion_candidates");
    expect(candidates[0]?.text).toContain("'candidate'");
  });

  it("a ref present in the snapshot NEVER becomes a candidate, and a reappeared ref resolves", async () => {
    const pool = refsPool(["a", "b", "c"], ["a", "b"], {
      resolvedRows: [{ external_ref: "c" }],
    });
    const client = membersClient([styleAPage([{ _id: "a" }, { _id: "b" }, { _id: "c" }])]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    // Nothing missing → no candidates, no alert.
    expect(outcomes[0]?.newCandidates).toBe(0);
    expect(outcomes[0]?.confirmed).toBe(0);
    expect(callsMatching(pool.calls, "insert into public.deletion_candidates")).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);

    // Reactivation (README §6): 'c' reappeared → its open candidate resolves
    // itself (status flip only — the row keeps its history).
    expect(outcomes[0]?.resolved).toBe(1);
    const resolved = callsMatching(pool.calls, "update public.deletion_candidates");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.text).toContain("status = 'resolved'");
    expect(resolved[0]?.values?.[2]).toEqual(["a", "b", "c"]);
    expect(String(resolved[0]?.values?.[3])).toContain("snapshot_reappeared");
  });

  it("paginates the FULL member list before diffing", async () => {
    const pool = refsPool(["a", "b", "c"], null);
    const client = membersClient([
      styleAPage([{ _id: "a" }], 1, true),
      styleAPage([{ _id: "b" }], 2, false),
    ]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.path).toContain("page=2");
    expect(outcomes[0]?.snapshotRefs).toBe(2);
    expect(outcomes[0]?.newCandidates).toBe(1); // only 'c' is missing
  });
});

describe("safety rules", () => {
  it("NEVER deletes or deactivates people — candidates are review items only", async () => {
    const pool = refsPool(["a", "b", "c"], ["a"]);
    const client = membersClient([styleAPage([{ _id: "a" }])]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    expect(outcomes[0]?.confirmed).toBe(2); // b and c both confirmed-missing…
    for (const call of pool.calls) {
      expect(call.text).not.toContain("delete from public.people");
      expect(call.text).not.toContain("update public.people");
      expect(call.text).not.toContain("active = false");
    }
  });

  it("a row with no readable _id ABORTS the entity — a dirty snapshot is not absence evidence", async () => {
    const pool = refsPool(["a", "b"], ["a", "b"]);
    const client = membersClient([styleAPage([{ _id: "a" }, { email: "no-id@example.com" }])]);

    const outcomes = await runDeletionDetection(pool, client, membersCtx());

    expect(outcomes[0]?.status).toBe("error");
    expect(String(outcomes[0]?.error)).toContain("_id");
    // NO snapshot row, NO candidates — garbage never creates tombstones.
    expect(callsMatching(pool.calls, "insert into public.import_snapshots")).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.deletion_candidates")).toHaveLength(0);
    const alerts = callsMatching(pool.calls, "insert into public.alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.values?.[1]).toBe("deletion_detection_error");
  });
});

describe("bookings deletion-in-source fact marks", () => {
  function bookingRefsPool(keloRefs: string[], previousRefs: string[] | null) {
    return createFakePool({
      respond: (text) => {
        if (text.includes("from public.import_snapshots")) {
          return previousRefs === null
            ? { rows: [] }
            : {
                rows: [
                  {
                    external_refs: previousRefs,
                    snapshot_at: "2026-07-16T23:00:00.000Z",
                  },
                ],
              };
        }
        if (text.includes("from public.glofox_bookings")) {
          return { rows: keloRefs.map((external_ref) => ({ external_ref })) };
        }
        if (text.includes("update public.deletion_candidates")) return { rows: [] };
        return undefined;
      },
    });
  }

  it("first miss creates a candidate but does not mark the booking deleted", async () => {
    const pool = bookingRefsPool(["a", "gone"], null);
    const client = createFakeClient(() => bookingsPage([{ _id: "a" }]));

    const outcomes = await runDeletionDetection(
      pool,
      client,
      makeCtx({ payload: { entities: ["bookings"] } }),
    );

    expect(outcomes[0]).toMatchObject({
      entity: "bookings",
      newCandidates: 1,
      confirmed: 0,
    });
    expect(callsMatching(pool.calls, "update public.glofox_bookings")).toHaveLength(0);
    const candidate = callsMatching(pool.calls, "insert into public.deletion_candidates")[0]!;
    expect(candidate.values?.[2]).toBe("gone");
    expect(candidate.text).toContain("'candidate'");
  });

  it("second consecutive miss confirms and soft-deletes only that booking fact", async () => {
    const pool = bookingRefsPool(["a", "gone"], ["a"]);
    const client = createFakeClient(() => bookingsPage([{ _id: "a" }]));

    const outcomes = await runDeletionDetection(
      pool,
      client,
      makeCtx({ payload: { entities: ["bookings"] } }),
    );

    expect(outcomes[0]).toMatchObject({
      entity: "bookings",
      newCandidates: 0,
      confirmed: 1,
    });
    const factMark = callsMatching(pool.calls, "update public.glofox_bookings");
    expect(factMark).toHaveLength(1);
    expect(factMark[0]?.text).toContain("set deleted_at = now()");
    expect(factMark[0]?.text).toContain("deleted_at is null");
    expect(factMark[0]?.values).toEqual([TENANT, ["gone"]]);
    expect(factMark[0]?.text).not.toContain("delete from");
  });
});
