import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  memberAuthStartBody,
  memberAuthStartResponse,
  memberAuthVerifyBody,
  memberAuthViewSchema,
  memberScheduleQuery,
  memberScheduleResponse,
  type MemberClaimStatus,
} from "@kelo/contracts";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import {
  appendMemberVerificationEvent,
  consumeMemberOtp,
  countRecentOtpChallenges,
  createNativePerson,
  enqueueMemberMessage,
  fetchMemberMe,
  insertMemberOtpAudit,
  isContactSuppressed,
  revokeMemberSession,
  fetchTenantName,
  findClaimsByContact,
  findPeopleByContact,
  insertMemberSession,
  insertOtpChallenge,
  insertPersonClaim,
  isStaffEmail,
  normalizeMemberContact,
} from "../data-member.js";
import { ApiError } from "../errors.js";
import {
  MEMBER_COOKIE,
  MEMBER_SESSION_ROLLING_MS,
  MEMBER_SESSION_ROLLING_SECONDS,
  MEMBER_TOKEN_PREFIX,
  resolveMember,
} from "../middleware/member.js";
import { memberOf, type AppEnv } from "../types.js";
import { parseBody, parseQuery } from "../validate.js";

interface QueryError {
  message: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

export interface MemberDeps {
  /**
   * Service-role client factory for the ANONYMOUS member group (schedule +
   * auth) and the resolveMember middleware. The member surface ships zero
   * Supabase material, so there is no member-scoped client: reads/writes use
   * the service role with explicit tenant filters, and the security boundary
   * is doubled (locked definer return shapes / hash-only tables with no
   * client grants + the routes' Zod response parses). Tests inject a
   * no-network fake.
   */
  createMemberClient?: () => KeloSupabaseClient;
  /**
   * Direct OTP sender. The OTP code must NEVER persist in a staff-readable
   * place, so it is NOT enqueued through the comms.send worker (that worker
   * sends comms_log.body_preview verbatim, and comms_log is staff-readable —
   * a read-the-code account-takeover, Opus review 8.2b). Instead the code is
   * handed straight to this sender at /start; only a REDACTED comms_log row
   * persists. The production default is a dry-run no-op (Resend/Twilio go live
   * at owner gate P3-2 — until then every comms send is dry-run anyway); when
   * P3-2 lands, wire the @kelo/comms adapter here. Tests inject a fake that
   * captures the message to assert the real code reached it.
   */
  sendMemberOtp?: (msg: {
    channel: "email" | "sms";
    toAddress: string;
    subject: string | null;
    body: string;
  }) => Promise<void>;
}

// -- member auth constants (plan-member-app §3.1/§3.2) -------------------------

/** OTP TTL (migration 0044 stores expires_at; the RPC enforces it). */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Hard session cap (12 months; the rolling 90-day window lives in the middleware). */
const MEMBER_SESSION_ABSOLUTE_MS = 365 * 24 * 60 * 60 * 1000;
/** Send-rate caps (§3.1 / threat model): 5 per contact per hour, 20 per IP per hour. */
const OTP_MAX_SENDS_PER_CONTACT_PER_HOUR = 5;
const OTP_MAX_SENDS_PER_IP_PER_HOUR = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const AUTH_DEFINITION_VERSION = "member-auth:v1";

/** ONE neutral failure for verify: unknown contact, wrong code, expired, and
 * locked are indistinguishable (the RPC already fails them identically). */
const NEUTRAL_CODE_MESSAGE = "the code is invalid or expired";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Client IP for the per-IP send cap — hashed before it goes anywhere. */
function ipHashOf(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return sha256Hex(forwarded !== undefined && forwarded !== "" ? forwarded : "unknown");
}

/**
 * The member route group (plan-member-app §3.5) — mounted OUTSIDE the operator
 * auth chain, next to the webhook mount. /member/schedule + /member/auth/* are
 * ANONYMOUS (pre-session); the tenant arrives as a PUBLIC uuid (pinned
 * client-side by KELO_TENANT_ID — the member client ships no Supabase
 * material, plan §5).
 *
 * EXTENSION POINT (unit 8.2c): session-scoped routes (refresh, logout, me,
 * step-up, account, bookings) mount `resolveMember(deps)` from
 * ../middleware/member.js and read identity via memberOf(c) — never from the
 * request. The desk path and the claim-status endpoint follow the same seam.
 */
export function registerMemberRoutes(app: Hono<AppEnv>, deps: MemberDeps = {}): void {
  const client = () => deps.createMemberClient?.() ?? createServiceRoleClient();
  // Default OTP sender: dry-run no-op until Resend/Twilio go live (owner gate
  // P3-2 — every comms adapter is dry-run today). The security property (the
  // code never persists readable) holds regardless of whether it delivers.
  const sendMemberOtp = deps.sendMemberOtp ?? (async () => {});

  app.get("/member/schedule", async (c) => {
    const { tenant, from, to } = parseQuery(c, memberScheduleQuery);
    const { data, error } = await (client() as unknown as RpcClient).rpc("member_schedule", {
      p_tenant: tenant,
      p_from: from,
      p_to: to,
    });
    if (error !== null) {
      // Structured 500, generic message; the DB detail goes to Sentry via the
      // app onError handler, never to an anonymous caller.
      throw new ApiError(500, "schedule_read_failed", "schedule read failed");
    }
    // Timestamps parse at the Zod boundary; unknown keys are stripped, so the
    // response can carry ONLY the public allowlist — zero attendee data.
    const sessions = memberScheduleResponse.parse(data ?? []);
    return c.json(
      c.var.ok(sessions, { source: "native", definitionVersion: "member-schedule:v1" }),
      200,
    );
  });

  /**
   * POST /member/auth/start — request an OTP (§3.3). Anti-enumeration is BY
   * CONSTRUCTION: every request with a normalizable contact runs the SAME
   * code path (rate-count → challenge insert → person lookup → dispatch →
   * audit) and gets the SAME neutral 202, whether or not the contact matches
   * an imported person. The only branches skip work for inputs that cannot
   * receive a message at all (un-normalizable contact, over the send caps) —
   * they never change the response, and they never key on match/no-match.
   */
  app.post("/member/auth/start", async (c) => {
    const body = await parseBody(c, memberAuthStartBody);
    const neutral = () =>
      c.json(
        c.var.ok(memberAuthStartResponse.parse({ sent: true }), {
          source: "native",
          definitionVersion: AUTH_DEFINITION_VERSION,
        }),
        202,
      );

    const contact = normalizeMemberContact(body.contact);
    if (contact === null) {
      // Not an email and not a US phone: no message can be addressed, but the
      // caller learns nothing from that.
      return neutral();
    }

    const db = client();
    const contactHash = sha256Hex(contact.normalized);
    const ipHash = ipHashOf(c);

    const counts = await countRecentOtpChallenges(
      db,
      body.tenant,
      { contactHash, ipHash },
      new Date(Date.now() - RATE_WINDOW_MS).toISOString(),
    );
    if (
      counts.byContact >= OTP_MAX_SENDS_PER_CONTACT_PER_HOUR ||
      counts.byIp >= OTP_MAX_SENDS_PER_IP_PER_HOUR
    ) {
      // Over the cap: the SAME neutral 202 — a distinct error would reveal
      // both the limit and that this contact is being sent to.
      return neutral();
    }

    // The raw code exists ONLY in this handler scope and the dispatched
    // message body — sha256 is what persists (never logged, never returned).
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await insertOtpChallenge(db, body.tenant, {
      contactHash,
      channel: contact.channel,
      codeHash: sha256Hex(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      ipHash,
    });

    // Identical lookup on hit AND miss: the match only decides the comms_log
    // person link, never the response or the dispatch target — the normalized
    // typed contact IS the canonical contact on file when a person matches
    // (citext email / E.164 phone), and the typed contact when none does
    // (new-member signup path, §3.3).
    const people = await findPeopleByContact(db, body.tenant, contact);
    const person = people.length === 1 ? people[0] : null;

    // Staff-contact hygiene (NOT a security control — the hazard class is
    // structurally gone, §3.1): a tenant_users staff email gets a "use the
    // staff app" note instead of an OTP. The response is still the neutral 202.
    const staffNote =
      contact.channel === "email" && (await isStaffEmail(db, body.tenant, contact.normalized));

    const studio = (await fetchTenantName(db, body.tenant)) ?? "studio";
    if (staffNote) {
      // Staff-app note carries NO code — the shared comms.send queue path is
      // safe (nothing secret to persist). Same neutral response as the OTP path.
      await enqueueMemberMessage(db, body.tenant, {
        personId: person?.id ?? null,
        channel: contact.channel,
        toAddress: contact.normalized,
        subject: contact.channel === "email" ? `Use the ${studio} staff app` : null,
        body: `You asked to sign in to the ${studio} member app with a staff email. Use the staff app instead — it has your schedule, roster, and desk tools.`,
        templateKey: "member_staff_note",
      });
    } else {
      // The OTP body is built once from a template so the sent (real) body and
      // the persisted (redacted) preview cannot drift. The code goes ONLY to
      // the sender; only the mask persists in comms_log (never a 6-digit run).
      const otpBody = (shown: string) =>
        `Your ${studio} sign-in code is ${shown}. It expires in 10 minutes.`;
      const subject = contact.channel === "email" ? `Your ${studio} sign-in code` : null;
      // Suppression (§3.3) still applies — the direct send replaces the worker's
      // suppression check, so run it here. Identical work on match AND miss.
      const suppressed = await isContactSuppressed(db, body.tenant, contact.channel, contact.normalized);
      if (!suppressed) {
        await sendMemberOtp({
          channel: contact.channel,
          toAddress: contact.normalized,
          subject,
          body: otpBody(code),
        });
      }
      await insertMemberOtpAudit(db, body.tenant, {
        personId: person?.id ?? null,
        channel: contact.channel,
        toAddress: contact.normalized,
        subject,
        redactedPreview: otpBody("••••••"),
        status: suppressed ? "suppressed" : "sent",
      });
    }

    await appendMemberVerificationEvent(db, body.tenant, {
      kind: "otp_sent",
      contactHash,
      ipHash,
      personId: person?.id,
    });
    return neutral();
  });

  /**
   * POST /member/auth/verify — consume the OTP, resolve the claim, mint the
   * session (§3.3). app.consume_member_otp is the ONLY verdict path; the
   * resolution matrix below runs only on its success.
   */
  app.post("/member/auth/verify", async (c) => {
    const body = await parseBody(c, memberAuthVerifyBody);
    const db = client();
    const neutralFailure = () => new ApiError(401, "invalid_code", NEUTRAL_CODE_MESSAGE);

    const contact = normalizeMemberContact(body.contact);
    if (contact === null) throw neutralFailure();

    const contactHash = sha256Hex(contact.normalized);
    const ipHash = ipHashOf(c);
    const verdict = await consumeMemberOtp(db, {
      tenantId: body.tenant,
      contactHash,
      channel: contact.channel,
      codeHash: sha256Hex(body.code.trim()),
      ipHash,
    });
    if (!verdict.success) throw neutralFailure();

    // -- Claim resolution (§3.3). EXACT match on the canonical columns. ------
    const people = await findPeopleByContact(db, body.tenant, contact);
    const claims = await findClaimsByContact(db, body.tenant, contact.normalized);
    const claimedVia = contact.channel === "email" ? ("self_email" as const) : ("self_sms" as const);
    const activeClaim = claims.find((claim) => claim.status === "active");
    const heldPersonIds = new Set(
      claims.filter((claim) => claim.status === "needs_resolution").map((claim) => claim.person_id),
    );
    const hasDeadClaim = claims.some(
      (claim) => claim.status === "revoked" || claim.status === "frozen",
    );
    const holdForResolution = async (personId: string): Promise<void> => {
      if (heldPersonIds.has(personId)) return; // already queued for staff — no dup
      await insertPersonClaim({ tenantId: body.tenant, personId }, db, {
        verifiedContact: contact.normalized,
        channel: contact.channel,
        status: "needs_resolution",
        claimedVia,
      });
    };

    let personId: string;
    let firstName: string | null;
    let claimStatus: MemberClaimStatus;
    let conflict = false;

    if (activeClaim !== undefined) {
      // A claim over an ACTIVE claim: the contact is already verified to a
      // person — staff must resolve it. 'claim_conflict' appended below; the
      // previously verified contact notification lands with the resolution
      // workspace (out of scope for 8.2b).
      conflict = true;
      claimStatus = "needs_resolution";
      personId = activeClaim.person_id;
      firstName = people.find((p) => p.id === personId)?.first_name ?? null;
      await holdForResolution(personId);
    } else if (people.length === 0) {
      // NO match → new-member signup: a native people row, claimed ACTIVE.
      const created = await createNativePerson(db, body.tenant, contact);
      personId = created.id;
      firstName = null;
      claimStatus = "active";
      const inserted = await insertPersonClaim({ tenantId: body.tenant, personId }, db, {
        verifiedContact: contact.normalized,
        channel: contact.channel,
        status: "active",
        claimedVia,
      });
      if (!inserted.ok) {
        // Lost a concurrent-claim race (the 0044 partial uniques): the DB is
        // the backstop — route this claimant to the resolution workspace too.
        conflict = true;
        claimStatus = "needs_resolution";
        await holdForResolution(personId);
      }
    } else if (people.length > 1) {
      // Ambiguous (a shared phone): EVERY match is queued for staff; the
      // session binds to the oldest match — resolveMember 403s it everywhere
      // until resolution, so the binding grants nothing pre-resolution.
      const first = people[0] as (typeof people)[number];
      claimStatus = "needs_resolution";
      personId = first.id;
      firstName = first.first_name;
      for (const match of people) {
        await holdForResolution(match.id);
      }
    } else {
      // Exactly one match.
      const person = people[0] as (typeof people)[number];
      personId = person.id;
      firstName = person.first_name;
      if (person.claim_frozen || hasDeadClaim || heldPersonIds.has(person.id)) {
        // Owner-frozen, recycled contact (a revoked/frozen claim exists), or
        // already queued → needs_resolution.
        claimStatus = "needs_resolution";
        await holdForResolution(person.id);
      } else {
        // Exactly one UNCLAIMED match → the happy path.
        claimStatus = "active";
        const inserted = await insertPersonClaim({ tenantId: body.tenant, personId }, db, {
          verifiedContact: contact.normalized,
          channel: contact.channel,
          status: "active",
          claimedVia,
        });
        if (!inserted.ok) {
          conflict = true;
          claimStatus = "needs_resolution";
          await holdForResolution(personId);
        }
      }
    }

    await appendMemberVerificationEvent(db, body.tenant, {
      kind: "claim_attempt",
      contactHash,
      ipHash,
      personId,
    });
    if (conflict) {
      await appendMemberVerificationEvent(db, body.tenant, {
        kind: "claim_conflict",
        contactHash,
        ipHash,
        personId,
      });
    }

    // -- Session minting (§3.2): kmb_ + 32 url-safe random bytes; ONLY the
    // sha256 hash persists — the raw token leaves exactly once, via the
    // host-only cookie (web) or this response body (mobile). ----------------
    const token = `${MEMBER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + MEMBER_SESSION_ROLLING_MS);
    const absoluteExpiresAt = new Date(nowMs + MEMBER_SESSION_ABSOLUTE_MS);
    await insertMemberSession({ tenantId: body.tenant, personId }, db, {
      tokenHash: sha256Hex(token),
      expiresAt: expiresAt.toISOString(),
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      platform: body.platform,
      deviceLabel: body.device_label ?? null,
    });

    if (body.platform === "web") {
      // HOST-ONLY (no Domain attribute — it must survive the Netlify
      // 200-proxy untouched), HttpOnly, Secure, SameSite=Lax.
      setCookie(c, MEMBER_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: MEMBER_SESSION_ROLLING_SECONDS,
      });
    }

    const view = memberAuthViewSchema.parse({
      member: { first_name: firstName, claim_status: claimStatus },
      session: {
        expires_at: expiresAt.toISOString(),
        absolute_expires_at: absoluteExpiresAt.toISOString(),
      },
      // Mobile gets the raw token in-body ONCE (SecureStore); web rides the cookie.
      ...(body.platform === "web" ? {} : { token }),
    });
    return c.json(
      c.var.ok(view, { source: "native", definitionVersion: AUTH_DEFINITION_VERSION }),
      200,
    );
  });

  // -- session-scoped routes (unit 8.2c) -------------------------------------
  // resolveMember is the SOLE source of identity; it 403s a needs_resolution /
  // absent claim, so only an ACTIVE session reaches these. Identity comes from
  // memberOf(c) — never from the request body.
  const memberAuth = resolveMember({ createMemberClient: deps.createMemberClient });

  /** GET /member/me — the signed-in member's first name + session window (no
   * balances/bookings; those are the account unit). */
  app.get("/member/me", memberAuth, async (c) => {
    const { memberTenantId, memberPersonId, memberSessionId } = memberOf(c);
    const me = await fetchMemberMe(
      { tenantId: memberTenantId, personId: memberPersonId },
      client(),
      memberSessionId,
    );
    if (me === null) throw new ApiError(404, "not_found", "member not found");
    const view = memberAuthViewSchema.parse({
      member: { first_name: me.first_name, claim_status: "active" },
      session: { expires_at: me.expires_at, absolute_expires_at: me.absolute_expires_at },
    });
    return c.json(
      c.var.ok(view, { source: "native", definitionVersion: AUTH_DEFINITION_VERSION }),
      200,
    );
  });

  /** POST /member/auth/logout — revoke THIS session (scoped so a token can only
   * revoke its own) and clear the host-only web cookie. Idempotent. */
  app.post("/member/auth/logout", memberAuth, async (c) => {
    const { memberTenantId, memberPersonId, memberSessionId } = memberOf(c);
    await revokeMemberSession(
      { tenantId: memberTenantId, personId: memberPersonId },
      client(),
      memberSessionId,
      new Date().toISOString(),
    );
    await appendMemberVerificationEvent(client(), memberTenantId, {
      kind: "session_revoked",
      contactHash: null,
      ipHash: null,
      personId: memberPersonId,
    });
    // Clear the cookie (host-only, matching the set attributes; maxAge 0).
    setCookie(c, MEMBER_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 0,
    });
    return c.json(
      c.var.ok({ revoked: true }, { source: "native", definitionVersion: AUTH_DEFINITION_VERSION }),
      200,
    );
  });
}
