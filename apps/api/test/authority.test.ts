import { describe, expect, it } from "vitest";
import { issueStepUpGrant } from "../src/auth/stepup.js";
import { createApp } from "../src/app.js";
import {
  AUTHORITY_FLIP_STEP_UP_CONTEXT,
  STEP_UP_GRANT_HEADER,
} from "../src/routes/authority.js";
import { fakeUserClient, TENANT_A, USER_ID, type RpcHandler } from "./fakes.js";

// STEP_UP_SECRET must be ≥32 bytes (auth/stepup.ts assertSecret).
const SECRET = "test-step-up-secret-key-32-bytes-min!!";
const FLIP_ID = "50000000-0000-4000-8000-000000000101";
const EVIDENCE = "https://ops.kelo.test/readiness/bookings";

// The invoker view rows the matrix read returns (unsorted on purpose — the data
// layer re-sorts into the closed-set order).
const matrixRows = [
  { domain: "retail", authority: "glofox", flipped_at: null, reason: null },
  { domain: "bookings", authority: "kelo", flipped_at: "2026-07-19T16:00:00.000Z", reason: "front-desk cutover" },
  { domain: "people", authority: "glofox", flipped_at: null, reason: null },
];

const defaultRpc: Record<string, RpcHandler> = {
  flip_authority: () => ({ data: FLIP_ID }),
};

function userFake(role: string, rpc: Record<string, RpcHandler> = defaultRpc) {
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
      current_authority: () => ({ data: matrixRows }),
    },
    rpc,
  );
}

function appFor(fake: ReturnType<typeof fakeUserClient>) {
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
    env: { STEP_UP_SECRET: SECRET },
  });
  return { app, fake };
}

function grantFor(context = AUTHORITY_FLIP_STEP_UP_CONTEXT, tenant = TENANT_A, sub = USER_ID) {
  return issueStepUpGrant({ sub, tenant, context }, SECRET);
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer t",
      "content-type": "application/json",
      "idempotency-key": "flip-key",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

// -- GET /authority — the matrix read (owner/manager) ---------------------------

describe("GET /authority — the launch-readiness matrix", () => {
  it("returns all domains through the envelope, sorted into the closed-set order", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/authority", {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { matrix: { domain: string; authority: string }[] };
      meta: { source: string };
    };
    // Sorted: people (2) < bookings (1)? closed-set order is people, bookings, …
    expect(payload.data.matrix.map((m) => m.domain)).toEqual(["people", "bookings", "retail"]);
    expect(payload.data.matrix.find((m) => m.domain === "bookings")?.authority).toBe("kelo");
    expect(payload.data.matrix.find((m) => m.domain === "retail")?.authority).toBe("glofox");
    expect(payload.meta.source).toBe("native");

    // The read filtered by the resolved tenant (RLS backstop + explicit filter).
    const read = fake.calls.find((c) => c.table === "current_authority" && c.method === "eq");
    expect(read?.args).toEqual(["tenant_id", TENANT_A]);
  });

  it("allows a manager to read the matrix", async () => {
    const fake = userFake("manager");
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/authority", {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
  });

  it("403s a front_desk (not owner/manager)", async () => {
    const fake = userFake("front_desk");
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/authority", {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "current_authority")).toBe(false);
  });
});

// -- POST /authority/flip — the cutover lever (owner + step-up + idempotency) ----

describe("POST /authority/flip — owner-only cutover flip", () => {
  it("threads the key, reason, domain, authority, evidence + actor into the RPC (201)", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/authority/flip",
      post(
        { domain: "bookings", authority: "kelo", reason: "front-desk bookings ready", evidence_url: EVIDENCE },
        { [STEP_UP_GRANT_HEADER]: grantFor(), "idempotency-key": "flip-1" },
      ),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      data: { flip: { id: string; domain: string; authority: string } };
    };
    expect(payload.data.flip.id).toBe(FLIP_ID);
    expect(payload.data.flip.domain).toBe("bookings");

    const rpc = fake.calls.find((c) => c.table === "flip_authority");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_domain).toBe("bookings");
    expect(params.p_authority).toBe("kelo");
    expect(params.p_reason).toBe("front-desk bookings ready");
    expect(params.p_actor).toBe(USER_ID);
    expect(params.p_idempotency_key).toBe("flip-1"); // the header key threads in
    expect(params.p_evidence_url).toBe(EVIDENCE);
  });

  it("defaults evidence_url to null when omitted", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    await app.request(
      "/api/v1/authority/flip",
      post(
        { domain: "payments", authority: "kelo", reason: "payments cutover" },
        { [STEP_UP_GRANT_HEADER]: grantFor() },
      ),
    );
    const rpc = fake.calls.find((c) => c.table === "flip_authority");
    expect((rpc?.args[0] as Record<string, unknown>).p_evidence_url).toBeNull();
  });

  it("401 step_up_required with NO grant, before the RPC", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/authority/flip",
      post({ domain: "bookings", authority: "kelo", reason: "no grant" }),
    );
    expect(res.status).toBe(401);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("step_up_required");
    expect(fake.calls.some((c) => c.table === "flip_authority")).toBe(false);
  });

  it("401 when the grant carries a DIFFERENT context (a refund grant cannot flip)", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/authority/flip",
      post(
        { domain: "bookings", authority: "kelo", reason: "wrong ctx" },
        { [STEP_UP_GRANT_HEADER]: grantFor("refund_over_threshold") },
      ),
    );
    expect(res.status).toBe(401);
    expect(fake.calls.some((c) => c.table === "flip_authority")).toBe(false);
  });

  it("403s a manager (owner-only) before idempotency + step-up + the RPC", async () => {
    const fake = userFake("manager");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/authority/flip",
      post(
        { domain: "bookings", authority: "kelo", reason: "manager try" },
        { [STEP_UP_GRANT_HEADER]: grantFor() },
      ),
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "flip_authority")).toBe(false);
  });

  it("422 without an Idempotency-Key, never reaching the RPC", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request("/api/v1/authority/flip", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
        [STEP_UP_GRANT_HEADER]: grantFor(),
      },
      body: JSON.stringify({ domain: "bookings", authority: "kelo", reason: "no key" }),
    });
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "flip_authority")).toBe(false);
  });

  it("422s an unknown domain at the Zod boundary, before the RPC", async () => {
    const fake = userFake("owner");
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/authority/flip",
      post(
        { domain: "nonsense", authority: "kelo", reason: "bad domain" },
        { [STEP_UP_GRANT_HEADER]: grantFor() },
      ),
    );
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "flip_authority")).toBe(false);
  });

  it("maps the RPC's 42501 (owner re-check) to 403 authority_forbidden", async () => {
    const fake = userFake("owner", {
      flip_authority: () => ({ data: null, error: { code: "42501", message: "owner role required" } }),
    });
    const { app } = appFor(fake);
    const res = await app.request(
      "/api/v1/authority/flip",
      post(
        { domain: "bookings", authority: "kelo", reason: "rpc refuses" },
        { [STEP_UP_GRANT_HEADER]: grantFor() },
      ),
    );
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("authority_forbidden");
  });
});
