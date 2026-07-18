import { describe, expect, it } from "vitest";
import { processors } from "../../src/processors.js";
import {
  createGlofoxProcessors,
  GLOFOX_DETECT_DELETIONS_KIND,
  GLOFOX_RECONCILE_KIND,
  GLOFOX_SYNC_ALL_KIND,
  GLOFOX_SYNC_KINDS,
} from "../../src/glofox/processors.js";
import type { TickCtx } from "../../src/processors.js";
import {
  callsMatching,
  createFakeClient,
  createFakePool,
  makeJob,
  memberRow,
  styleAPage,
  TENANT,
  testConfig,
} from "./helpers.js";

/**
 * Processor registration + the fan-out. The registry module must import
 * cleanly with NO Glofox env set (config resolves per run, not at load).
 */

describe("registry", () => {
  it("registers the six entity kinds + the fan-out, keeping noop/heartbeat", () => {
    for (const kind of GLOFOX_SYNC_KINDS) {
      expect(processors[kind]).toBeTypeOf("function");
    }
    expect(processors[GLOFOX_SYNC_ALL_KIND]).toBeTypeOf("function");
    expect(processors["noop"]).toBeTypeOf("function");
    expect(processors["heartbeat"]).toBeTypeOf("function");
  });

  it("registers the unit-1.5 trust-engine kinds", () => {
    expect(processors[GLOFOX_RECONCILE_KIND]).toBeTypeOf("function");
    expect(processors[GLOFOX_DETECT_DELETIONS_KIND]).toBeTypeOf("function");
  });
});

describe("glofox.sync.* processors", () => {
  function makeCtx(pool: ReturnType<typeof createFakePool>): TickCtx {
    return { pool, workerId: "w-test" };
  }

  it("fails loudly when the job row has no tenant", async () => {
    const procs = createGlofoxProcessors({
      client: createFakeClient(() => styleAPage([])),
      config: testConfig,
    });
    const pool = createFakePool();
    await expect(
      procs["glofox.sync.members"]!(makeJob({ tenant_id: null }), makeCtx(pool)),
    ).rejects.toThrow(/requires a tenant/);
  });

  it("runs the members pipeline for a tenant job (client + config injected)", async () => {
    const client = createFakeClient(() => styleAPage([memberRow("m1")]));
    const procs = createGlofoxProcessors({ client, config: testConfig });
    const pool = createFakePool();

    await procs["glofox.sync.members"]!(makeJob(), makeCtx(pool));

    expect(client.calls).toHaveLength(1);
    expect(callsMatching(pool.calls, "set committed_watermark")).toHaveLength(1);
  });

  it("each registered kind maps to its entity's endpoint", async () => {
    const styleBPage = { data: [], success: true, meta: { totalCount: 0, page: 1, limit: 100 } };
    const report = { TransactionsList: { header: "h", details: [] } };
    const client = createFakeClient((path) => {
      if (path.startsWith("/Analytics")) return report;
      if (path.startsWith("/2.2")) return styleBPage;
      return styleAPage([]);
    });
    const procs = createGlofoxProcessors({ client, config: testConfig });
    const expectations: Record<string, string> = {
      "glofox.sync.members": "/2.0/members",
      "glofox.sync.memberships": "/2.0/memberships",
      "glofox.sync.events": "/2.0/branches/test-branch-id/events",
      "glofox.sync.bookings": "/2.2/branches/test-branch-id/bookings",
      "glofox.sync.transactions": "/Analytics/report",
      "glofox.sync.credits": "/2.0/credits",
    };
    for (const [kind, path] of Object.entries(expectations)) {
      const pool = createFakePool({
        syncState: { plausible_zero: true },
        respond: (text) => {
          // Credits iterates people — give the chunk one member to fetch for.
          if (text.includes("from public.people")) {
            return { rows: [{ id: "person-1", external_ref: "u1" }] };
          }
          return undefined;
        },
      });
      await procs[kind]!(makeJob({ kind }), makeCtx(pool));
      const hit = client.calls.find((call) => call.path.startsWith(path));
      expect(hit, `${kind} should fetch ${path}`).toBeDefined();
    }
  });
});

describe("glofox.sync.all fan-out", () => {
  it("enqueues the six entity jobs + the trust-engine jobs with hour-scoped idempotency keys", async () => {
    const pool = createFakePool();
    const procs = createGlofoxProcessors({
      client: createFakeClient(() => styleAPage([])),
      config: testConfig,
      now: () => new Date("2026-07-17T23:13:00.000Z"),
    });

    await procs[GLOFOX_SYNC_ALL_KIND]!(makeJob({ kind: GLOFOX_SYNC_ALL_KIND }), {
      pool,
      workerId: "w-test",
    });

    const enqueues = callsMatching(pool.calls, "app.enqueue_job");
    expect(enqueues).toHaveLength(8);
    const kinds = enqueues.map((call) => call.values?.[0]);
    expect(kinds).toEqual([
      ...GLOFOX_SYNC_KINDS,
      GLOFOX_RECONCILE_KIND,
      GLOFOX_DETECT_DELETIONS_KIND,
    ]);
    for (const call of enqueues) {
      expect(call.values?.[2]).toBe(TENANT);
      expect(String(call.values?.[3])).toBe(`${String(call.values?.[0])}:${TENANT}:2026-07-17T23`);
    }
  });

  it("requires a tenant too", async () => {
    const pool = createFakePool();
    const procs = createGlofoxProcessors({
      client: createFakeClient(() => ({})),
      config: testConfig,
    });
    await expect(
      procs[GLOFOX_SYNC_ALL_KIND]!(makeJob({ tenant_id: null }), { pool, workerId: "w-test" }),
    ).rejects.toThrow(/requires a tenant/);
  });
});
