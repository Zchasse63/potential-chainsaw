import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, type RecordedCall, TENANT_A, USER_ID } from "./fakes.js";

/**
 * Phase 7 · unit 7.1b — launch-readiness computation + acknowledgment.
 *
 * Every gate is computed from REAL data (plan-ux §G: "completion detected from
 * real data, not self-report"): an EMPTY tenant fails every hard gate, and the
 * absence of a reconciliation run is an honest FAIL, never a pass. Acks are
 * append-only audit_events rows, only valid for non-hard warn gates, and never
 * change a gate's status (acknowledge ≠ resolve, plan-ux §F).
 */

const NOW = "2026-07-19T12:00:00.000Z";
const EARLIER = "2026-07-19T08:00:00.000Z";
const SECOND_USER = "55555555-5555-4555-8555-555555555555";
const ROW_ID = "22222222-2222-4222-8222-222222222222";

type Role = "owner" | "manager" | "front_desk";

interface Scenario {
  role?: Role;
  roster?: { user_id: string; role: string }[];
  reconciliations?: unknown[];
  payments?: unknown[];
  waivers?: unknown[];
  resources?: unknown[];
  offerings?: unknown[];
  plans?: unknown[];
  comms?: unknown[];
  bookings?: unknown[];
  acks?: unknown[];
  auditInsertError?: { message: string } | null;
}

function build(s: Scenario) {
  const role: Role = s.role ?? "owner";
  const roster = s.roster ?? [{ user_id: USER_ID, role }];
  const f = fakeUserClient({
    // resolveTenant filters user_id (membership); the roles_assigned gate reads
    // the whole active roster (no user_id filter) — differentiate on that.
    tenant_users: (calls: RecordedCall[]) => {
      const isMembership = calls.some((c) => c.method === "eq" && c.args[0] === "user_id");
      if (isMembership) return { data: [{ tenant_id: TENANT_A, role }] };
      return { data: roster };
    },
    reconciliations: () => ({ data: s.reconciliations ?? [] }),
    payments: () => ({ data: s.payments ?? [] }),
    waiver_versions: () => ({ data: s.waivers ?? [] }),
    resources: () => ({ data: s.resources ?? [] }),
    offering_templates: () => ({ data: s.offerings ?? [] }),
    plan_catalog: () => ({ data: s.plans ?? [] }),
    comms_log: () => ({ data: s.comms ?? [] }),
    bookings: () => ({ data: s.bookings ?? [] }),
    audit_events: (calls: RecordedCall[]) => {
      const isInsert = calls.some((c) => c.method === "insert");
      if (isInsert) return { data: null, error: s.auditInsertError ?? null };
      return { data: s.acks ?? [] };
    },
  });
  return {
    app: createApp({ verifyAccessToken: async () => ({ userId: USER_ID }), createUserClient: () => f.client }),
    calls: f.calls,
  };
}

const authed = (extra: Record<string, string> = {}) => ({ authorization: "Bearer token", ...extra });

/** Every input present → every hard gate passes; a second member passes roles. */
const passing: Scenario = {
  roster: [
    { user_id: USER_ID, role: "owner" },
    { user_id: SECOND_USER, role: "front_desk" },
  ],
  reconciliations: [{ entity: "payments", status: "match", checked_at: NOW }],
  payments: [{ id: ROW_ID, created_at: NOW }],
  waivers: [{ id: ROW_ID, effective_from: NOW, created_at: NOW }],
  resources: [{ id: ROW_ID }],
  offerings: [{ id: ROW_ID }],
  plans: [{ id: ROW_ID }],
  comms: [{ id: ROW_ID, created_at: NOW }],
  bookings: [{ id: ROW_ID, created_at: NOW }],
};

function gatesOf(body: { data: { gates: { key: string; status: string; hard: boolean; acknowledged: unknown }[] } }) {
  return new Map(body.data.gates.map((g) => [g.key, g]));
}

describe("GET /readiness — false-pass probes (empty tenant)", () => {
  it("fails every hard gate on an empty tenant, warns the soft/single-operator gates", async () => {
    const { app } = build({});
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as never;
    const gates = gatesOf(body);

    // hard gates FAIL when their input is absent
    expect(gates.get("reconciliation_green")?.status).toBe("fail");
    expect(gates.get("payment_verified")?.status).toBe("fail");
    expect(gates.get("active_waiver")?.status).toBe("fail");
    expect(gates.get("resources_configured")?.status).toBe("fail");
    expect(gates.get("plans_configured")?.status).toBe("fail");
    expect(gates.get("delivery_tested")?.status).toBe("fail");

    // roles_assigned is HARD but single-operator = warn (documented), never fail
    expect(gates.get("roles_assigned")?.hard).toBe(true);
    expect(gates.get("roles_assigned")?.status).toBe("warn");

    // native_booking_exercised is a soft warn gate
    expect(gates.get("native_booking_exercised")?.hard).toBe(false);
    expect(gates.get("native_booking_exercised")?.status).toBe("warn");
  });

  it("a missing reconciliation run FAILS reconciliation_green (absence is never a pass)", async () => {
    const { app } = build({});
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    const body = (await res.json()) as { data: { gates: { key: string; status: string; evidence: { counts: { runs: number }; as_of: string | null } }[] } };
    const recon = body.data.gates.find((g) => g.key === "reconciliation_green");
    expect(recon?.status).toBe("fail");
    expect(recon?.evidence.counts.runs).toBe(0);
    expect(recon?.evidence.as_of).toBeNull();
  });
});

describe("GET /readiness — pass shapes + stage derivation", () => {
  it("passes every gate with synthetic inputs and marks all five stages complete", async () => {
    const { app } = build(passing);
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { gates: { key: string; status: string }[]; stages: { key: string; complete: boolean; gate_keys: string[] }[] }; meta: { source: string; definition_version: string } };

    for (const g of body.data.gates) {
      expect(["pass"]).toContain(g.status);
    }
    expect(body.data.stages).toHaveLength(5);
    for (const st of body.data.stages) expect(st.complete).toBe(true);
    expect(body.meta.source).toBe("mixed");
    expect(body.meta.definition_version).toBe("readiness:v1");
  });

  it("derives stage.complete from the absence of a FAIL, not from warns", async () => {
    // Single-operator (roles warn) + no native booking (soft warn), everything
    // else present → studio_team + rooms_services still complete (warns don't
    // block); only import_reconciliation etc. fail when their input is missing.
    const { app } = build({
      roster: [{ user_id: USER_ID, role: "owner" }],
      resources: [{ id: ROW_ID }],
      offerings: [{ id: ROW_ID }],
      bookings: [],
    });
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    const body = (await res.json()) as { data: { stages: { key: string; complete: boolean }[] } };
    const stages = new Map(body.data.stages.map((s) => [s.key, s.complete]));
    expect(stages.get("studio_team")).toBe(true); // roles warn does not block
    expect(stages.get("rooms_services")).toBe(true); // resources pass + soft warn
    expect(stages.get("import_reconciliation")).toBe(false); // recon fail blocks
    expect(stages.get("payments_waivers_launch")).toBe(false); // hard fails block
  });

  it("a run that exists but has drift FAILS reconciliation_green (latest-per-entity variance)", async () => {
    const { app } = build({
      reconciliations: [
        { entity: "payments", status: "drift", checked_at: NOW },
        { entity: "members", status: "match", checked_at: EARLIER },
      ],
    });
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    const body = (await res.json()) as { data: { gates: { key: string; status: string; evidence: { detail: string | null; counts: { variances: number } } }[] } };
    const recon = body.data.gates.find((g) => g.key === "reconciliation_green");
    expect(recon?.status).toBe("fail");
    expect(recon?.evidence.counts.variances).toBe(1);
    expect(recon?.evidence.detail).toContain("payments");
  });

  it("passes roles_assigned when a second active member exists", async () => {
    const { app } = build({ roster: [{ user_id: USER_ID, role: "owner" }, { user_id: SECOND_USER, role: "manager" }] });
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    const body = (await res.json()) as never;
    expect(gatesOf(body).get("roles_assigned")?.status).toBe("pass");
  });

  it("reflects an existing ack without changing the gate's status (acknowledge ≠ resolve)", async () => {
    const { app } = build({
      acks: [{ target_id: "native_booking_exercised", metadata: { note: "beta launch, will exercise live" }, created_at: NOW }],
    });
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    const body = (await res.json()) as never;
    const gate = gatesOf(body).get("native_booking_exercised") as { status: string; acknowledged: { at: string; note: string } | null };
    expect(gate.status).toBe("warn"); // still a warn
    expect(gate.acknowledged).toEqual({ at: NOW, note: "beta launch, will exercise live" });
  });
});

describe("GET /readiness — role gating", () => {
  it("front_desk cannot read the readiness surface (403)", async () => {
    const { app } = build({ role: "front_desk" });
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    expect(res.status).toBe(403);
  });

  it("manager can read the readiness surface (200)", async () => {
    const { app } = build({ ...passing, role: "manager" });
    const res = await app.request("/api/v1/readiness", { headers: authed() });
    expect(res.status).toBe(200);
  });
});

describe("POST /readiness/ack — validation + append-only write", () => {
  it("rejects acknowledging a HARD gate (422, no audit insert)", async () => {
    const { app, calls } = build({});
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed({ "idempotency-key": "ack-1" }),
      body: JSON.stringify({ gate_key: "reconciliation_green", note: "we'll reconcile after launch" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("gate_not_acknowledgeable");
    expect(calls.some((c) => c.table === "audit_events" && c.method === "insert")).toBe(false);
  });

  it("rejects an empty note (422, no audit insert)", async () => {
    const { app, calls } = build({});
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed({ "idempotency-key": "ack-2" }),
      body: JSON.stringify({ gate_key: "native_booking_exercised", note: "   " }),
    });
    expect(res.status).toBe(422);
    expect(calls.some((c) => c.table === "audit_events" && c.method === "insert")).toBe(false);
  });

  it("rejects an unknown gate key (422)", async () => {
    const { app } = build({});
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed({ "idempotency-key": "ack-3" }),
      body: JSON.stringify({ gate_key: "not_a_gate", note: "hi" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_gate");
  });

  it("rejects acknowledging a soft gate that is currently PASS (422 gate_not_in_warn_state)", async () => {
    // A native booking exists → native_booking_exercised is 'pass', nothing to ack.
    const { app, calls } = build({ bookings: [{ id: ROW_ID, created_at: NOW }] });
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed({ "idempotency-key": "ack-4" }),
      body: JSON.stringify({ gate_key: "native_booking_exercised", note: "already exercised" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("gate_not_in_warn_state");
    expect(calls.some((c) => c.table === "audit_events" && c.method === "insert")).toBe(false);
  });

  it("requires an idempotency key (422)", async () => {
    const { app } = build({});
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ gate_key: "native_booking_exercised", note: "ok" }),
    });
    expect(res.status).toBe(422);
  });

  it("a non-owner cannot acknowledge (403, no audit insert)", async () => {
    const { app, calls } = build({ role: "manager" });
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed({ "idempotency-key": "ack-5" }),
      body: JSON.stringify({ gate_key: "native_booking_exercised", note: "ok" }),
    });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.table === "audit_events" && c.method === "insert")).toBe(false);
  });

  it("owner acknowledges a soft WARN gate — writes an append-only audit row with actor stamped", async () => {
    const { app, calls } = build({}); // native_booking_exercised is warn (no bookings)
    const res = await app.request("/api/v1/readiness/ack", {
      method: "POST",
      headers: authed({ "idempotency-key": "ack-6" }),
      body: JSON.stringify({ gate_key: "native_booking_exercised", note: "beta launch — will exercise live" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { gate_key: string; acknowledged: { note: string } } };
    expect(body.data.gate_key).toBe("native_booking_exercised");
    expect(body.data.acknowledged.note).toBe("beta launch — will exercise live");

    const insert = calls.find((c) => c.table === "audit_events" && c.method === "insert");
    expect(insert).toBeDefined();
    expect(insert?.args[0]).toMatchObject({
      tenant_id: TENANT_A,
      actor_user_id: USER_ID,
      actor_role: "owner",
      action: "readiness.gate.acknowledged",
      target_type: "readiness_gate",
      target_id: "native_booking_exercised",
      metadata: { note: "beta launch — will exercise live" },
    });
  });
});
