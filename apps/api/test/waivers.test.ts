import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID } from "./fakes.js";

/**
 * Phase 4.3 — waiver engine API (the desk-signing slice). The signature write
 * goes through record_waiver_signature (append-only legal evidence); version
 * management is owner/manager-gated; the desk-sign route enforces
 * acknowledged=true + a non-empty typed name before the RPC is ever reached.
 */

const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_ID = "33333333-3333-4333-8333-333333333333";
const SIGNATURE_ID = "44444444-4444-4444-8444-444444444444";

function fake(role: "owner" | "front_desk" | "trainer") {
  return fakeUserClient(
    {
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
      tenants: () => ({ data: [{ id: TENANT_A, name: "Kelo" }] }),
      waiver_versions: () => ({
        data: [{ id: VERSION_ID, version: 1, title: "Liability", body: "I acknowledge…", active: true, effective_from: "2026-07-18T00:00:00.000Z", created_at: "2026-07-18T00:00:00.000Z" }],
      }),
    },
    {
      activate_waiver_version: () => ({ data: true }),
      current_waiver_status: () => ({ data: [{ has_current_signature: false, signed_version: null, active_version: 1, needs_signature: true }] }),
      record_waiver_signature: () => ({ data: SIGNATURE_ID }),
    },
  );
}

function app(role: "owner" | "front_desk" | "trainer") {
  const f = fake(role);
  return {
    app: createApp({ verifyAccessToken: async () => ({ userId: USER_ID }), createUserClient: () => f.client }),
    calls: f.calls,
  };
}

const authed = (extra: Record<string, string> = {}) => ({ authorization: "Bearer token", ...extra });

describe("waiver version management — owner/manager only", () => {
  it("front_desk cannot create a version (403, no insert)", async () => {
    const { app: a, calls } = app("front_desk");
    const res = await a.request("/api/v1/waivers/versions", {
      method: "POST",
      headers: authed({ "idempotency-key": "v-1" }),
      body: JSON.stringify({ body: "I acknowledge the risks." }),
    });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.table === "waiver_versions" && c.method === "insert")).toBe(false);
  });

  it("front_desk cannot activate a version (403, no rpc)", async () => {
    const { app: a, calls } = app("front_desk");
    const res = await a.request(`/api/v1/waivers/versions/${VERSION_ID}/activate`, {
      method: "POST",
      headers: authed({ "idempotency-key": "act-1" }),
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.table === "activate_waiver_version")).toBe(false);
  });

  it("owner activates via the RPC with the resolved tenant + actor", async () => {
    const { app: a, calls } = app("owner");
    const res = await a.request(`/api/v1/waivers/versions/${VERSION_ID}/activate`, {
      method: "POST",
      headers: authed({ "idempotency-key": "act-2" }),
      body: "{}",
    });
    expect(res.status).toBe(200);
    const rpc = calls.find((c) => c.table === "activate_waiver_version");
    expect(rpc?.args[0]).toEqual({ p_tenant: TENANT_A, p_version_id: VERSION_ID, p_actor: USER_ID });
  });
});

describe("desk signature — append-only capture", () => {
  it("rejects acknowledged=false before the RPC (422, no signature)", async () => {
    const { app: a, calls } = app("front_desk");
    const res = await a.request("/api/v1/waivers/sign", {
      method: "POST",
      headers: authed({ "idempotency-key": "sign-1" }),
      body: JSON.stringify({ person_id: PERSON_ID, waiver_version_id: VERSION_ID, typed_name: "Jane Doe", acknowledged: false }),
    });
    expect(res.status).toBe(422);
    expect(calls.some((c) => c.table === "record_waiver_signature")).toBe(false);
  });

  it("rejects an empty typed name (422, no signature)", async () => {
    const { app: a, calls } = app("front_desk");
    const res = await a.request("/api/v1/waivers/sign", {
      method: "POST",
      headers: authed({ "idempotency-key": "sign-2" }),
      body: JSON.stringify({ person_id: PERSON_ID, waiver_version_id: VERSION_ID, typed_name: "   ", acknowledged: true }),
    });
    expect(res.status).toBe(422);
    expect(calls.some((c) => c.table === "record_waiver_signature")).toBe(false);
  });

  it("front_desk records a valid desk signature via the append-only RPC (source=desk, resolved tenant+actor)", async () => {
    const { app: a, calls } = app("front_desk");
    const res = await a.request("/api/v1/waivers/sign", {
      method: "POST",
      headers: authed({ "idempotency-key": "sign-3", "user-agent": "kiosk/1.0" }),
      body: JSON.stringify({ person_id: PERSON_ID, waiver_version_id: VERSION_ID, typed_name: "Jane Doe", acknowledged: true }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ data: { signature_id: SIGNATURE_ID } });
    const rpc = calls.find((c) => c.table === "record_waiver_signature");
    expect(rpc?.args[0]).toMatchObject({
      p_tenant: TENANT_A,
      p_person: PERSON_ID,
      p_waiver_version: VERSION_ID,
      p_typed_name: "Jane Doe",
      p_acknowledged: true,
      p_source: "desk",
      p_actor: USER_ID,
      p_user_agent: "kiosk/1.0",
      p_link_token_hash: null,
    });
  });

  it("requires an idempotency key on sign", async () => {
    const { app: a } = app("front_desk");
    const res = await a.request("/api/v1/waivers/sign", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ person_id: PERSON_ID, waiver_version_id: VERSION_ID, typed_name: "Jane Doe", acknowledged: true }),
    });
    expect(res.status).toBe(422);
  });
});

describe("per-person waiver status", () => {
  it("returns the current status via the invoker RPC", async () => {
    const { app: a, calls } = app("front_desk");
    const res = await a.request(`/api/v1/waivers/status/${PERSON_ID}`, { headers: authed() });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { status: { needs_signature: true, active_version: 1 } } });
    const rpc = calls.find((c) => c.table === "current_waiver_status");
    expect(rpc?.args[0]).toEqual({ p_tenant: TENANT_A, p_person: PERSON_ID });
  });
});
