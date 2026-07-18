import { describe, expect, it } from "vitest";
import { envelope, errorResponseSchema } from "@kelo/contracts";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID, type TableHandler } from "./fakes.js";

/**
 * Import review API (unit 1.6) — quarantine queue, batch commit, and the
 * reconciliation bridge to unit 1.5 (the 42P01 honest-degrade path).
 */

const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QID_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01";
const QID_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02";
const QID_3 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03";
const REC_ID = "99999999-9999-4999-8999-999999999999";

function quarantineRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    entity: "members",
    external_ref: `gfx-${id.slice(-2)}`,
    reason: "unknown_glofox_event",
    status: "open",
    sync_run_id: RUN_ID,
    created_at: "2026-07-17T10:00:00.000Z",
    resolved_at: null,
    resolution_note: null,
    ...overrides,
  };
}

function reconciliationRow() {
  // The pinned 1.5 read-shape — keep in lockstep with data.ts RECONCILIATION_COLUMNS.
  return {
    id: REC_ID,
    tenant_id: TENANT_A,
    entity: "transactions",
    window_start: "2026-07-16T00:00:00.000Z",
    window_end: "2026-07-17T00:00:00.000Z",
    glofox_count: 41,
    kelo_count: 41,
    glofox_sum: 1234.5,
    kelo_sum: 1234.5,
    drift_count: 0,
    drift_sum: 0,
    status: "match",
    detail: {},
    checked_at: "2026-07-17T11:00:00.000Z",
    created_at: "2026-07-17T11:00:00.000Z",
  };
}

/** import_quarantine answers: resolve update vs detail (payload) vs cause scan vs list page. */
const defaultQuarantineHandler: TableHandler = (tableCalls) => {
  if (tableCalls.some((call) => call.method === "update")) {
    return {
      data: [
        quarantineRow(QID_1, {
          status: "resolved",
          resolved_at: "2026-07-17T12:00:00.000Z",
        }),
      ],
    };
  }
  const select = tableCalls.find((call) => call.method === "select");
  const columns = String(select?.args[0] ?? "");
  if (columns.includes("payload")) {
    return {
      data: [{ ...quarantineRow(QID_1), payload: { glofox_event: "mystery", raw: [1, 2] } }],
    };
  }
  if (columns === "entity, reason") {
    return {
      data: [
        { entity: "members", reason: "unknown_glofox_event" },
        { entity: "members", reason: "unknown_glofox_event" },
        { entity: "transactions", reason: "missing_namespace" },
      ],
    };
  }
  return { data: [quarantineRow(QID_1), quarantineRow(QID_2), quarantineRow(QID_3)] };
};

function buildApp(
  options: {
    role?: string;
    quarantineHandler?: TableHandler;
    reconciliationsHandler?: TableHandler;
  } = {},
) {
  const fake = fakeUserClient({
    tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: options.role ?? "owner" }] }),
    import_quarantine: options.quarantineHandler ?? defaultQuarantineHandler,
    reconciliations: options.reconciliationsHandler ?? (() => ({ data: [reconciliationRow()] })),
    audit_events: () => ({ data: null }),
  });
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
  });
  return { app, fake };
}

const authed = { headers: { authorization: "Bearer good-token" } };

function postResolve(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/api/v1/import/quarantine/resolve", {
    method: "POST",
    headers: {
      authorization: "Bearer good-token",
      "content-type": "application/json",
      "idempotency-key": "key-resolve-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("GET /api/v1/import/quarantine", () => {
  it("returns exceptions grouped by cause plus one page of items, enveloped", async () => {
    const { app, fake } = buildApp();
    const res = await app.request("/api/v1/import/quarantine", authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        causes: Array<{ entity: string; reason: string; open_count: number }>;
        items: Array<Record<string, unknown>>;
        next_cursor: string | null;
      };
      meta: unknown;
    };
    expect(() => envelope(z.unknown()).parse(body)).not.toThrow();

    // Grouped by (entity, reason), most common first — the batch-decision unit.
    expect(body.data.causes).toEqual([
      { entity: "members", reason: "unknown_glofox_event", open_count: 2 },
      { entity: "transactions", reason: "missing_namespace", open_count: 1 },
    ]);
    expect(body.data.items).toHaveLength(3);
    expect(body.data.next_cursor).toBeNull(); // 3 items < default limit 50

    // The list must NOT carry payload — evidence is detail-route only.
    for (const item of body.data.items) {
      expect("payload" in item).toBe(false);
    }
    const listSelect = fake.calls.find(
      (call) =>
        call.table === "import_quarantine" &&
        call.method === "select" &&
        String(call.args[0]).includes("external_ref"),
    );
    expect(listSelect).toBeDefined();
    expect(String(listSelect?.args[0])).not.toContain("payload");
  });

  it("403s front_desk — the review queue is owner/manager work", async () => {
    const { app, fake } = buildApp({ role: "front_desk" });
    const res = await app.request("/api/v1/import/quarantine", authed);
    expect(res.status).toBe(403);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("insufficient_role");
    // The guard fired before any quarantine read.
    expect(fake.calls.some((call) => call.table === "import_quarantine")).toBe(false);
  });

  it("401s without a token — never 200-with-failure", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/v1/import/quarantine");
    expect(res.status).toBe(401);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });
});

describe("GET /api/v1/import/quarantine/:id", () => {
  it("returns one row WITH payload — the before/after preview source", async () => {
    const { app } = buildApp();
    const res = await app.request(`/api/v1/import/quarantine/${QID_1}`, authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { item: Record<string, unknown> } };
    expect(body.data.item["id"]).toBe(QID_1);
    expect(body.data.item["payload"]).toEqual({ glofox_event: "mystery", raw: [1, 2] });
  });

  it("404s when the row is absent (or cross-tenant — RLS filters it identically)", async () => {
    const { app } = buildApp({ quarantineHandler: () => ({ data: [] }) });
    const res = await app.request(`/api/v1/import/quarantine/${QID_1}`, authed);
    expect(res.status).toBe(404);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("quarantine_not_found");
  });

  it("403s a trainer", async () => {
    const { app } = buildApp({ role: "trainer" });
    const res = await app.request(`/api/v1/import/quarantine/${QID_1}`, authed);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/import/quarantine/resolve — the commit", () => {
  it("updates ONLY the column-list-granted resolution fields, scoped + forward-only", async () => {
    const { app, fake } = buildApp();
    const res = await postResolve(app, { ids: [QID_1], status: "resolved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ status: string }> } };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.status).toBe("resolved");

    const update = fake.calls.find(
      (call) => call.table === "import_quarantine" && call.method === "update",
    );
    expect(update).toBeDefined();
    // Migration 0007's column-list grant, exactly — evidence columns untouched.
    expect(Object.keys(update?.args[0] as Record<string, unknown>).sort()).toEqual([
      "resolution_note",
      "resolved_at",
      "resolved_by",
      "status",
    ]);
    const patch = update?.args[0] as Record<string, unknown>;
    expect(patch["status"]).toBe("resolved");
    // Actor stamped from the VERIFIED SESSION, never client input.
    expect(patch["resolved_by"]).toBe(USER_ID);

    // Scoped to the resolved tenant + forward-only (open → resolved/dismissed).
    const eqs = fake.calls.filter(
      (call) => call.table === "import_quarantine" && call.method === "eq",
    );
    expect(eqs.some((call) => call.args[0] === "tenant_id" && call.args[1] === TENANT_A)).toBe(
      true,
    );
    expect(eqs.some((call) => call.args[0] === "status" && call.args[1] === "open")).toBe(true);
    const inCall = fake.calls.find(
      (call) => call.table === "import_quarantine" && call.method === "in",
    );
    expect(inCall?.args[0]).toBe("id");
    expect(inCall?.args[1]).toEqual([QID_1]);
  });

  it("writes ONE audit_events row per batch, actor from the session — a forged actor is stripped", async () => {
    const { app, fake } = buildApp();
    const res = await postResolve(app, {
      ids: [QID_1, QID_2],
      status: "dismissed",
      note: "Vendor confirmed these are test rows",
      actor_user_id: "00000000-0000-4000-8000-000000000000", // forged — Zod drops it unread
    });
    expect(res.status).toBe(200);

    const auditInserts = fake.calls.filter(
      (call) => call.table === "audit_events" && call.method === "insert",
    );
    expect(auditInserts).toHaveLength(1);
    const event = auditInserts[0]?.args[0] as Record<string, unknown>;
    expect(event["tenant_id"]).toBe(TENANT_A);
    expect(event["actor_user_id"]).toBe(USER_ID);
    expect(event["actor_role"]).toBe("owner");
    expect(event["action"]).toBe("import.quarantine_resolved");
    expect(event["metadata"]).toEqual({ ids: [QID_1, QID_2], status: "dismissed" });

    const update = fake.calls.find(
      (call) => call.table === "import_quarantine" && call.method === "update",
    );
    expect((update?.args[0] as Record<string, unknown>)["resolved_by"]).toBe(USER_ID);
  });

  it("422s a batch over 200 ids — batch decisions are bounded", async () => {
    const { app, fake } = buildApp();
    const ids = Array.from(
      { length: 201 },
      (_, i) => `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, "0")}`,
    );
    const res = await postResolve(app, { ids, status: "resolved" });
    expect(res.status).toBe(422);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("validation_error");
    // Nothing was written.
    expect(
      fake.calls.some((call) => call.table === "import_quarantine" && call.method === "update"),
    ).toBe(false);
    expect(fake.calls.some((call) => call.table === "audit_events")).toBe(false);
  });

  it("422s without an Idempotency-Key header", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/v1/import/quarantine/resolve", {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ ids: [QID_1], status: "resolved" }),
    });
    expect(res.status).toBe(422);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("idempotency_key_required");
  });

  it("422s a dismiss without a note — the audit trail needs the why", async () => {
    const { app } = buildApp();
    const res = await postResolve(app, { ids: [QID_1], status: "dismissed" });
    expect(res.status).toBe(422);
  });

  it("403s front_desk and 403s trainer — no write happened", async () => {
    for (const role of ["front_desk", "trainer"]) {
      const { app, fake } = buildApp({ role });
      const res = await postResolve(app, { ids: [QID_1], status: "resolved" });
      expect(res.status).toBe(403);
      expect(fake.calls.some((call) => call.table === "import_quarantine")).toBe(false);
      expect(fake.calls.some((call) => call.table === "audit_events")).toBe(false);
    }
  });
});

describe("GET /api/v1/import/reconciliations", () => {
  it("returns the reconciliation history in the pinned 1.5 shape, enveloped", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/v1/import/reconciliations", authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { reconciliations: Array<Record<string, unknown>>; reconciliation_pending: boolean };
    };
    expect(() => envelope(z.unknown()).parse(body)).not.toThrow();
    expect(body.data.reconciliation_pending).toBe(false);
    expect(body.data.reconciliations).toHaveLength(1);
    const row = body.data.reconciliations[0];
    expect(row?.["status"]).toBe("match");
    expect(row?.["glofox_count"]).toBe(41);
    expect(row?.["kelo_count"]).toBe(41);
  });

  it("42P01 (table not yet landed by unit 1.5) degrades honestly — pending:true, never 500", async () => {
    const { app } = buildApp({
      reconciliationsHandler: () => ({
        data: null,
        error: { message: 'relation "public.reconciliations" does not exist', code: "42P01" },
      }),
    });
    const res = await app.request("/api/v1/import/reconciliations", authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { reconciliations: unknown[]; reconciliation_pending: boolean };
      meta: Record<string, unknown>;
    };
    expect(() => envelope(z.unknown()).parse(body)).not.toThrow();
    expect(body.data.reconciliations).toEqual([]);
    expect(body.data.reconciliation_pending).toBe(true);
    // The bridge contract also flags meta (additive; contracts strips it client-side).
    expect(body.meta["reconciliation_pending"]).toBe(true);
  });

  it("any OTHER database error is a 500, not a fake pending state", async () => {
    const { app } = buildApp({
      reconciliationsHandler: () => ({
        data: null,
        error: { message: "connection terminated", code: "08006" },
      }),
    });
    const res = await app.request("/api/v1/import/reconciliations", authed);
    expect(res.status).toBe(500);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("internal_error");
  });

  it("403s front_desk", async () => {
    const { app } = buildApp({ role: "front_desk" });
    const res = await app.request("/api/v1/import/reconciliations", authed);
    expect(res.status).toBe(403);
  });
});
