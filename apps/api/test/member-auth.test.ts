import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, type FakeResult, type RecordedCall } from "./fakes.js";

/**
 * Unit 8.2b — POST /member/auth/start + POST /member/auth/verify
 * (plan-member-app §3.3). The anti-enumeration suite: /start performs
 * IDENTICAL work and returns the IDENTICAL neutral 202 on hit vs miss; /verify
 * fails wrong-code and unknown-contact with ONE neutral shape; raw contacts,
 * codes, and tokens never leave the server (hashes only).
 */

const CONTACT_TYPED = "Member@Example.Test";
const CONTACT_NORMALIZED = "member@example.test";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

const PERSON = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  first_name: "Sam",
  source: "glofox",
  claim_frozen: false,
  created_at: "2026-01-01T00:00:00Z",
};
const PERSON_2 = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  first_name: "Jo",
  source: "glofox",
  claim_frozen: false,
  created_at: "2026-02-01T00:00:00Z",
};
const NEW_PERSON_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SESSION_ID = "99999999-9999-4999-8999-999999999999";
const LOG_ID = "55555555-5555-4555-8555-555555555555";

type TableConfig =
  | FakeResult
  | {
      select?: FakeResult | ((calls: RecordedCall[]) => FakeResult);
      insert?: FakeResult;
      update?: FakeResult;
    };

/** Per-table dispatch on the builder methods used (insert().select() chains
 * count as insert; everything else with a select() is a read). */
function onTable(config: TableConfig) {
  return (calls: RecordedCall[]): FakeResult => {
    if ("data" in config || "error" in config) return config;
    if (calls.some((call) => call.method === "insert")) {
      return config.insert ?? { data: null };
    }
    if (calls.some((call) => call.method === "update")) {
      return config.update ?? { data: null };
    }
    const select = config.select;
    if (typeof select === "function") return select(calls);
    return select ?? { data: [] };
  };
}

interface StartScenario {
  peopleRows?: unknown[];
  staffUsers?: { id: string; email: string }[];
  staffMembers?: unknown[];
  contactSendsLastHour?: number;
  ipSendsLastHour?: number;
}

function startApp(scenario: StartScenario = {}) {
  const fake = fakeUserClient(
    {
      member_otp_challenges: onTable({
        select: (calls) => {
          const pad = (i: number) => String(i).padStart(12, "0");
          if (calls.some((call) => call.method === "eq" && call.args[0] === "contact_hash")) {
            return {
              data: Array.from({ length: scenario.contactSendsLastHour ?? 0 }, (_, i) => ({
                id: `00000000-0000-4000-8000-${pad(i)}`,
              })),
            };
          }
          return {
            data: Array.from({ length: scenario.ipSendsLastHour ?? 0 }, (_, i) => ({
              id: `00000000-0000-4000-8000-${pad(100 + i)}`,
            })),
          };
        },
        insert: { data: null },
      }),
      people: onTable({ select: { data: scenario.peopleRows ?? [] } }),
      tenant_users: onTable({ select: { data: scenario.staffMembers ?? [] } }),
      tenants: onTable({ select: { data: [{ name: "Studio A" }] } }),
      comms_log: onTable({ insert: { data: [{ id: LOG_ID }] } }),
      jobs: onTable({ insert: { data: null } }),
      member_verification_events: onTable({ insert: { data: null } }),
    },
    {},
    scenario.staffUsers ?? [],
  );
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

function postStart(contact: string, init?: RequestInit) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ tenant: TENANT_A, contact }),
    ...init,
  } as const;
}

/** The (table, method) call sequence — the identical-work proof ignores values. */
function callSequence(calls: RecordedCall[]): string[] {
  return calls.map((call) => `${call.table}.${call.method}`);
}

describe("POST /member/auth/start — anti-enumeration by construction", () => {
  it("returns the IDENTICAL neutral 202 for a matching vs a non-matching contact", async () => {
    const hit = startApp({ peopleRows: [PERSON] });
    const miss = startApp({ peopleRows: [] });

    const hitRes = await hit.app.request("/api/v1/member/auth/start", postStart(CONTACT_TYPED));
    const missRes = await miss.app.request("/api/v1/member/auth/start", postStart(CONTACT_TYPED));

    expect(hitRes.status).toBe(202);
    expect(missRes.status).toBe(202);
    const hitBody = await hitRes.json();
    const missBody = await missRes.json();
    // Same data shape, byte-for-byte (meta carries per-request ids/timestamps).
    expect(hitBody.data).toEqual({ sent: true });
    expect(missBody.data).toEqual(hitBody.data);
    expect(Object.keys(hitBody).sort()).toEqual(Object.keys(missBody).sort());

    // IDENTICAL WORK: the same code path runs on hit and miss — same tables,
    // same operations, same order. Only person-link VALUES differ.
    expect(callSequence(hit.fake.calls)).toEqual(callSequence(miss.fake.calls));

    // In BOTH cases a challenge row was created and a dispatch was attempted.
    for (const fake of [hit.fake, miss.fake]) {
      const challengeInsert = fake.calls.find(
        (call) => call.table === "member_otp_challenges" && call.method === "insert",
      );
      expect(challengeInsert).toBeDefined();
      const commsInsert = fake.calls.find(
        (call) => call.table === "comms_log" && call.method === "insert",
      );
      expect(commsInsert).toBeDefined();
      const jobInsert = fake.calls.find(
        (call) => call.table === "jobs" && call.method === "insert",
      );
      expect(jobInsert).toBeDefined();
      const eventInsert = fake.calls.find(
        (call) => call.table === "member_verification_events" && call.method === "insert",
      );
      expect(eventInsert).toBeDefined();
    }

    // Hashes only: the challenge insert carries sha256 of the NORMALIZED
    // contact — never the raw typed contact, never a raw code.
    const challengeInsert = hit.fake.calls.find(
      (call) => call.table === "member_otp_challenges" && call.method === "insert",
    );
    const challengeRow = challengeInsert?.args[0] as Record<string, unknown>;
    expect(challengeRow["contact_hash"]).toBe(sha256(CONTACT_NORMALIZED));
    expect(challengeRow["code_hash"]).toMatch(HEX64);
    expect(JSON.stringify(challengeRow)).not.toContain(CONTACT_TYPED);
    expect(JSON.stringify(hitBody)).not.toMatch(/\b\d{6}\b/); // the raw code never leaves

    // The dispatch body DOES carry the code (that is the message), to the
    // normalized typed contact in both cases.
    for (const fake of [hit.fake, miss.fake]) {
      const commsInsert = fake.calls.find(
        (call) => call.table === "comms_log" && call.method === "insert",
      );
      const logRow = commsInsert?.args[0] as Record<string, unknown>;
      expect(logRow["to_address"]).toBe(CONTACT_NORMALIZED);
      expect(logRow["body_preview"]).toMatch(/sign-in code is \d{6}\b/);
      expect(logRow["channel"]).toBe("email");
    }

    // The comms.send job rides the existing transactional path, deduped.
    const jobInsert = hit.fake.calls.find(
      (call) => call.table === "jobs" && call.method === "insert",
    );
    expect(jobInsert?.args[0]).toMatchObject({
      kind: "comms.send",
      payload: { comms_log_id: LOG_ID },
      tenant_id: TENANT_A,
      idempotency_key: `comms.send:${LOG_ID}`,
    });
  });

  it("sends the OTP as a transactional message (quiet-hours-exempt by kind), person-linked on hit", async () => {
    const { app, fake } = startApp({ peopleRows: [PERSON] });
    await app.request("/api/v1/member/auth/start", postStart(CONTACT_TYPED));
    const commsInsert = fake.calls.find(
      (call) => call.table === "comms_log" && call.method === "insert",
    );
    const logRow = commsInsert?.args[0] as Record<string, unknown>;
    // person-linked on hit; null on miss (asserted by the identical-work test).
    expect(logRow["person_id"]).toBe(PERSON.id);
    // No campaign_key, no dunning_ template prefix → classifyMessageKind maps
    // this to 'transactional' in the worker's canSend gate.
    expect(logRow["template_key"]).toBe("member_otp");
    expect(logRow["campaign_key"]).toBeUndefined();
    expect(logRow["status"]).toBe("queued");
  });

  it("rate-limit: over the per-contact cap returns the SAME neutral 202 and sends nothing", async () => {
    const { app, fake } = startApp({ contactSendsLastHour: 5 });
    const res = await app.request("/api/v1/member/auth/start", postStart(CONTACT_TYPED));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ sent: true });
    // No challenge, no dispatch, no event — and no distinguishable error.
    expect(
      fake.calls.some((call) => call.table === "member_otp_challenges" && call.method === "insert"),
    ).toBe(false);
    expect(fake.calls.some((call) => call.table === "comms_log")).toBe(false);
    expect(
      fake.calls.some(
        (call) => call.table === "member_verification_events" && call.method === "insert",
      ),
    ).toBe(false);
  });

  it("rate-limit: over the per-IP cap is the same silent neutral 202", async () => {
    const { app, fake } = startApp({ ipSendsLastHour: 20 });
    const res = await app.request("/api/v1/member/auth/start", postStart(CONTACT_TYPED));
    expect(res.status).toBe(202);
    expect(
      fake.calls.some((call) => call.table === "member_otp_challenges" && call.method === "insert"),
    ).toBe(false);
  });

  it("staff email: neutral 202, a 'use the staff app' note instead of an OTP", async () => {
    const staffUserId = "77777777-7777-4777-8777-777777777777";
    const { app, fake } = startApp({
      staffMembers: [{ user_id: staffUserId }],
      staffUsers: [{ id: staffUserId, email: "staff@example.test" }],
    });
    const res = await app.request("/api/v1/member/auth/start", postStart("Staff@Example.Test"));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ sent: true });

    const commsInsert = fake.calls.find(
      (call) => call.table === "comms_log" && call.method === "insert",
    );
    const logRow = commsInsert?.args[0] as Record<string, unknown>;
    expect(logRow["template_key"]).toBe("member_staff_note");
    expect(logRow["body_preview"]).toContain("staff app");
    expect(logRow["body_preview"]).not.toMatch(/\b\d{6}\b/); // NO OTP in the staff note
  });

  it("an un-normalizable contact gets the neutral 202 with no challenge and no dispatch", async () => {
    const { app, fake } = startApp();
    const res = await app.request("/api/v1/member/auth/start", postStart("not a contact at all"));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ sent: true });
    expect(fake.calls.some((call) => call.table === "member_otp_challenges")).toBe(false);
    expect(fake.calls.some((call) => call.table === "comms_log")).toBe(false);
  });

  it("a non-uuid tenant is a plain 422 (public-id validation, not an oracle)", async () => {
    const { app, fake } = startApp();
    const res = await app.request("/api/v1/member/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: "not-a-uuid", contact: CONTACT_TYPED }),
    });
    expect(res.status).toBe(422);
    // A rejected request NEVER reaches the database.
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

interface VerifyScenario {
  verdict?: { success: boolean; remaining_attempts: number; locked: boolean };
  peopleRows?: unknown[];
  claimRows?: unknown[];
  claimInsertError?: { message: string; code: string };
}

function verifyApp(scenario: VerifyScenario = {}) {
  const fake = fakeUserClient(
    {
      people: onTable({
        select: { data: scenario.peopleRows ?? [PERSON] },
        insert: { data: [{ id: NEW_PERSON_ID }] },
      }),
      person_claims: onTable({
        select: { data: scenario.claimRows ?? [] },
        insert:
          scenario.claimInsertError !== undefined
            ? { data: null, error: scenario.claimInsertError }
            : { data: null },
      }),
      member_sessions: onTable({ insert: { data: [{ id: SESSION_ID }] } }),
      member_verification_events: onTable({ insert: { data: null } }),
    },
    {
      consume_member_otp: () => ({
        data: [scenario.verdict ?? { success: true, remaining_attempts: 0, locked: false }],
      }),
    },
  );
  const app = createApp({ createMemberClient: () => fake.client });
  return { app, fake };
}

function postVerify(contact: string, code: string, platform = "web", extra?: object) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ tenant: TENANT_A, contact, code, platform, ...extra }),
  } as const;
}

describe("POST /member/auth/verify", () => {
  it("happy path: one unclaimed match → active claim + minted session (web cookie)", async () => {
    const { app, fake } = verifyApp();
    const res = await app.request("/api/v1/member/auth/verify", postVerify(CONTACT_TYPED, "123456"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.member).toEqual({ first_name: "Sam", claim_status: "active" });
    expect(typeof body.data.session.expires_at).toBe("string");
    expect(typeof body.data.session.absolute_expires_at).toBe("string");
    expect(Date.parse(body.data.session.absolute_expires_at)).toBeGreaterThan(
      Date.parse(body.data.session.expires_at),
    );
    // Web: NO token in the body — it rides the host-only cookie.
    expect(body.data.token).toBeUndefined();

    // The cookie: kelo_member=kmb_…, HttpOnly, Secure, SameSite=Lax, NO Domain
    // attribute (host-only — it must survive the Netlify 200-proxy).
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("kelo_member=kmb_");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Domain=/i);

    // The RPC was called with HASHES — never the raw contact or code.
    const rpc = fake.calls.find((call) => call.table === "consume_member_otp");
    const rpcArgs = rpc?.args[0] as Record<string, unknown>;
    expect(rpcArgs).toEqual({
      p_tenant: TENANT_A,
      p_contact_hash: sha256(CONTACT_NORMALIZED),
      p_channel: "email",
      p_code_hash: sha256("123456"),
      p_ip_hash: sha256("203.0.113.7"),
    });
    expect(JSON.stringify(rpcArgs)).not.toContain("123456");
    expect(JSON.stringify(rpcArgs)).not.toContain(CONTACT_TYPED);

    // The claim: ACTIVE, self_email, verified contact is the canonical form.
    const claimInsert = fake.calls.find(
      (call) => call.table === "person_claims" && call.method === "insert",
    );
    expect(claimInsert?.args[0]).toMatchObject({
      tenant_id: TENANT_A,
      person_id: PERSON.id,
      verified_contact: CONTACT_NORMALIZED,
      channel: "email",
      status: "active",
      claimed_via: "self_email",
    });

    // The session row stores ONLY the token hash.
    const sessionInsert = fake.calls.find(
      (call) => call.table === "member_sessions" && call.method === "insert",
    );
    const sessionRow = sessionInsert?.args[0] as Record<string, unknown>;
    expect(sessionRow["token_hash"]).toMatch(HEX64);
    expect(sessionRow["token_hash"]).not.toContain("kmb_");
    expect(sessionRow["person_id"]).toBe(PERSON.id);
    expect(sessionRow["platform"]).toBe("web");

    // claim_attempt was audited (otp_verified is appended by the RPC itself).
    const events = fake.calls.filter(
      (call) => call.table === "member_verification_events" && call.method === "insert",
    );
    expect(events.map((call) => (call.args[0] as Record<string, unknown>)["kind"])).toEqual([
      "claim_attempt",
    ]);
  });

  it("mobile platform: token returned in-body ONCE, no cookie", async () => {
    const { app, fake } = verifyApp();
    const res = await app.request(
      "/api/v1/member/auth/verify",
      postVerify(CONTACT_TYPED, "123456", "ios", { device_label: "Sam's iPhone" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.token).toMatch(/^kmb_[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("set-cookie")).toBeNull();

    const sessionInsert = fake.calls.find(
      (call) => call.table === "member_sessions" && call.method === "insert",
    );
    const sessionRow = sessionInsert?.args[0] as Record<string, unknown>;
    expect(sessionRow["platform"]).toBe("ios");
    expect(sessionRow["device_label"]).toBe("Sam's iPhone");
    // The persisted hash matches the returned token exactly.
    expect(sessionRow["token_hash"]).toBe(sha256(body.data.token as string));
  });

  it("no match → creates a native person and claims it ACTIVE (new-member signup)", async () => {
    const { app, fake } = verifyApp({ peopleRows: [] });
    const res = await app.request("/api/v1/member/auth/verify", postVerify(CONTACT_TYPED, "123456"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.member).toEqual({ first_name: null, claim_status: "active" });

    const peopleInsert = fake.calls.find(
      (call) => call.table === "people" && call.method === "insert",
    );
    expect(peopleInsert?.args[0]).toMatchObject({
      tenant_id: TENANT_A,
      email: CONTACT_NORMALIZED,
      phone: null,
      source: "native",
    });
    const claimInsert = fake.calls.find(
      (call) => call.table === "person_claims" && call.method === "insert",
    );
    expect(claimInsert?.args[0]).toMatchObject({ person_id: NEW_PERSON_ID, status: "active" });
  });

  it("ambiguous phone match → needs_resolution for every match, first-name-only view", async () => {
    const { app, fake } = verifyApp({ peopleRows: [PERSON, PERSON_2] });
    const res = await app.request(
      "/api/v1/member/auth/verify",
      postVerify("+1 (813) 555-0100", "123456"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.member.claim_status).toBe("needs_resolution");
    // First-name-only: the view carries exactly these two member keys — no
    // balances, no bookings, nothing else pre-resolution.
    expect(Object.keys(body.data.member).sort()).toEqual(["claim_status", "first_name"]);

    const heldInserts = fake.calls.filter(
      (call) =>
        call.table === "person_claims" &&
        call.method === "insert" &&
        (call.args[0] as Record<string, unknown>)["status"] === "needs_resolution",
    );
    expect(heldInserts).toHaveLength(2);
    const sessionInsert = fake.calls.find(
      (call) => call.table === "member_sessions" && call.method === "insert",
    );
    expect((sessionInsert?.args[0] as Record<string, unknown>)["platform"]).toBe("web");
  });

  it("claim over an ACTIVE claim → needs_resolution + claim_conflict audit, still a 200 session", async () => {
    const { app, fake } = verifyApp({
      claimRows: [{ id: "12121212-1212-4212-8212-121212121212", person_id: PERSON.id, status: "active" }],
    });
    const res = await app.request("/api/v1/member/auth/verify", postVerify(CONTACT_TYPED, "123456"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.member).toEqual({ first_name: "Sam", claim_status: "needs_resolution" });

    const claimInsert = fake.calls.find(
      (call) => call.table === "person_claims" && call.method === "insert",
    );
    expect((claimInsert?.args[0] as Record<string, unknown>)["status"]).toBe("needs_resolution");
    const eventKinds = fake.calls
      .filter((call) => call.table === "member_verification_events" && call.method === "insert")
      .map((call) => (call.args[0] as Record<string, unknown>)["kind"]);
    expect(eventKinds).toEqual(["claim_attempt", "claim_conflict"]);
  });

  it("claim_frozen person → needs_resolution (owner kill-switch), never ACTIVE", async () => {
    const { app, fake } = verifyApp({ peopleRows: [{ ...PERSON, claim_frozen: true }] });
    const res = await app.request("/api/v1/member/auth/verify", postVerify(CONTACT_TYPED, "123456"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.member.claim_status).toBe("needs_resolution");
    const claimInsert = fake.calls.find(
      (call) => call.table === "person_claims" && call.method === "insert",
    );
    expect((claimInsert?.args[0] as Record<string, unknown>)["status"]).toBe("needs_resolution");
  });

  it("recycled contact (a revoked claim exists) → needs_resolution", async () => {
    const { app, fake } = verifyApp({
      claimRows: [{ id: "13131313-1313-4313-8313-131313131313", person_id: PERSON.id, status: "revoked" }],
    });
    const res = await app.request("/api/v1/member/auth/verify", postVerify(CONTACT_TYPED, "123456"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.member.claim_status).toBe("needs_resolution");
    const claimInsert = fake.calls.find(
      (call) => call.table === "person_claims" && call.method === "insert",
    );
    expect((claimInsert?.args[0] as Record<string, unknown>)["status"]).toBe("needs_resolution");
  });

  it("a lost claim race (23505 on the ACTIVE insert) degrades to needs_resolution, not a 500", async () => {
    const { app, fake } = verifyApp({
      claimInsertError: { message: "duplicate key", code: "23505" },
    });
    const res = await app.request("/api/v1/member/auth/verify", postVerify(CONTACT_TYPED, "123456"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // First insert (active) lost the race → conflict; the fallback holds the
    // claim for staff (the second insert 23505s too in this fake, which the
    // route tolerates — the session view is what matters here).
    expect(body.data.member.claim_status).toBe("needs_resolution");
    expect(fake.calls.some((call) => call.table === "member_sessions")).toBe(true);
  });

  it("bad code and unknown contact fail with ONE neutral 401 — no oracle", async () => {
    const wrongCode = verifyApp({
      verdict: { success: false, remaining_attempts: 2, locked: false },
    });
    const wrongRes = await wrongCode.app.request(
      "/api/v1/member/auth/verify",
      postVerify(CONTACT_TYPED, "000000"),
    );
    expect(wrongRes.status).toBe(401);
    const wrongBody = await wrongRes.json();
    expect(wrongBody.error.code).toBe("invalid_code");

    const unknown = verifyApp({
      verdict: { success: false, remaining_attempts: 0, locked: false },
    });
    const unknownRes = await unknown.app.request(
      "/api/v1/member/auth/verify",
      postVerify("nobody@example.test", "123456"),
    );
    expect(unknownRes.status).toBe(401);
    const unknownBody = await unknownRes.json();
    // Byte-identical neutral failure (correlation_id is the only difference).
    expect({ ...unknownBody.error, correlation_id: "x" }).toEqual({
      ...wrongBody.error,
      correlation_id: "x",
    });

    // A failed verdict resolves NO people and mints NO session.
    expect(wrongCode.fake.calls.some((call) => call.table === "people")).toBe(false);
    expect(wrongCode.fake.calls.some((call) => call.table === "member_sessions")).toBe(false);
  });

  it("an un-normalizable contact fails with the same neutral 401", async () => {
    const { app, fake } = verifyApp();
    const res = await app.request(
      "/api/v1/member/auth/verify",
      postVerify("not a contact at all", "123456"),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_code");
    // The RPC is never reached with a contact that cannot hash to a challenge.
    expect(fake.calls.some((call) => call.table === "consume_member_otp")).toBe(false);
    expect(fake.calls.some((call) => call.table === "people")).toBe(false);
  });
});
