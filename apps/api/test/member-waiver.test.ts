import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";
import { MEMBER_COOKIE } from "../src/middleware/member.js";

/**
 * Unit 8.3i — member self-serve waiver signing (GET /member/waiver +
 * POST /member/waiver/sign). Security-critical route logic: the person is the
 * SESSION's person (never a request-supplied one), the active waiver version is
 * resolved SERVER-SIDE (the request carries no version id), and no active
 * version → 404. The RPC's service-role gate is proven by attack block 39.
 */

const TOKEN = "kmb_testtoken0000000000000000000000000000000000a";
const MEMBER_SESSION_ID = "99999999-9999-4999-8999-999999999999";
const PERSON_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_PERSON = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
// Distinct from TENANT_A (also aaaa… in fakes) so the "server-resolved version,
// not the tenant, not the injected id" assertion is unambiguous.
const WAIVER_VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_VERSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SIGNATURE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUTURE = "2099-01-01T00:00:00Z";

const ACTIVE_VERSION = {
  id: WAIVER_VERSION_ID,
  version: 1,
  title: "Liability Waiver",
  body: "You assume all risk of sauna and cold plunge.",
  active: true,
  effective_from: FUTURE,
  created_at: FUTURE,
};

function waiverApp(scenario: {
  needsSignature?: boolean;
  hasActive?: boolean;
  signError?: { code: string; message: string };
} = {}) {
  const fake = fakeUserClient(
    {
      member_sessions: (calls: RecordedCall[]): FakeResult => {
        if (calls.some((c) => c.method === "update")) return { data: null };
        return {
          data: [
            {
              id: MEMBER_SESSION_ID,
              tenant_id: TENANT_A,
              person_id: PERSON_ID,
              expires_at: FUTURE,
              absolute_expires_at: FUTURE,
              revoked_at: null,
              step_up_at: null,
            },
          ],
        };
      },
      person_claims: (): FakeResult => ({ data: [{ status: "active" }] }),
      waiver_versions: (): FakeResult => ({
        data: (scenario.hasActive ?? true) ? [ACTIVE_VERSION] : [],
      }),
    },
    {
      current_waiver_status: (): FakeResult => ({
        data: [
          {
            has_current_signature: !(scenario.needsSignature ?? true),
            signed_version: null,
            active_version: 1,
            needs_signature: scenario.needsSignature ?? true,
          },
        ],
      }),
      record_waiver_signature: (): FakeResult =>
        scenario.signError !== undefined
          ? { error: scenario.signError }
          : { data: SIGNATURE_ID },
    },
  );
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

const cookie = { headers: { cookie: `${MEMBER_COOKIE}=${TOKEN}` } };
// Deliberately NO idempotency-key header — waiver signing is not a money
// mutation, and these tests prove the route doesn't require one.
const postJson = (body: unknown) => ({
  method: "POST",
  headers: { cookie: `${MEMBER_COOKIE}=${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /member/waiver", () => {
  it("returns the active waiver text + needs_signature for the session person", async () => {
    const { app } = waiverApp({ needsSignature: true });
    const res = await app.request("/api/v1/member/waiver", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { needs_signature: boolean; version: { id: string; body: string } | null };
    };
    expect(body.data.needs_signature).toBe(true);
    expect(body.data.version?.id).toBe(WAIVER_VERSION_ID);
    expect(body.data.version?.body).toContain("assume all risk");
  });

  it("returns version:null + needs_signature:false when no active waiver exists", async () => {
    const { app } = waiverApp({ hasActive: false, needsSignature: false });
    const res = await app.request("/api/v1/member/waiver", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { needs_signature: boolean; version: unknown } };
    expect(body.data.version).toBeNull();
    expect(body.data.needs_signature).toBe(false);
  });

  it("401s (neutral) without a session", async () => {
    const { app } = waiverApp();
    const res = await app.request("/api/v1/member/waiver");
    expect(res.status).toBe(401);
  });
});

describe("POST /member/waiver/sign", () => {
  it("signs for the SESSION person + the SERVER-resolved active version (ignores injected ids)", async () => {
    const { app, fake } = waiverApp();
    const res = await app.request(
      "/api/v1/member/waiver/sign",
      // Inject a foreign person + version in the body — both must be ignored.
      postJson({ typed_name: "Jane Member", acknowledged: true, person_id: OTHER_PERSON, waiver_version_id: OTHER_VERSION_ID }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { signature_id: string; waiver_version_id: string } };
    expect(body.data.signature_id).toBe(SIGNATURE_ID);
    expect(body.data.waiver_version_id).toBe(WAIVER_VERSION_ID);

    const rpc = fake.calls.find((c) => c.table === "record_waiver_signature");
    const params = rpc?.args[0] as Record<string, unknown>;
    expect(params.p_person).toBe(PERSON_ID); // session person, NOT OTHER_PERSON
    expect(params.p_waiver_version).toBe(WAIVER_VERSION_ID); // server-resolved, NOT OTHER_VERSION
    expect(params.p_source).toBe("member_portal");
    expect(params.p_acknowledged).toBe(true);
    expect(params.p_tenant).toBe(TENANT_A);
    expect(params.p_actor).toBeNull();
  });

  it("requires acknowledged === true (a false/missing ack is a 422 validation error)", async () => {
    const { app, fake } = waiverApp();
    const res = await app.request("/api/v1/member/waiver/sign", postJson({ typed_name: "Jane", acknowledged: false }));
    expect(res.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "record_waiver_signature")).toBe(false);
  });

  it("404s (no RPC) when the studio has no active waiver version", async () => {
    const { app, fake } = waiverApp({ hasActive: false });
    const res = await app.request("/api/v1/member/waiver/sign", postJson({ typed_name: "Jane", acknowledged: true }));
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.table === "record_waiver_signature")).toBe(false);
  });

  it("maps the active-version-changed race (RPC 22023) to a distinguishable 409", async () => {
    const { app } = waiverApp({
      signError: { code: "22023", message: "member portal capture must use the active waiver version" },
    });
    const res = await app.request("/api/v1/member/waiver/sign", postJson({ typed_name: "Jane", acknowledged: true }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("waiver_version_changed");
  });

  it("maps the service-role gate refusal (RPC 42501) to 403", async () => {
    const { app } = waiverApp({ signError: { code: "42501", message: "not service role" } });
    const res = await app.request("/api/v1/member/waiver/sign", postJson({ typed_name: "Jane", acknowledged: true }));
    expect(res.status).toBe(403);
  });

  it("401s (neutral) without a session — never reaches the RPC", async () => {
    const { app, fake } = waiverApp();
    const res = await app.request("/api/v1/member/waiver/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typed_name: "Jane", acknowledged: true }),
    });
    expect(res.status).toBe(401);
    expect(fake.calls.some((c) => c.table === "record_waiver_signature")).toBe(false);
  });
});
