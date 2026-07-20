import { z } from "zod";

/**
 * Unit 8.1c — the ANONYMOUS member schedule (plan-member-app §3.5). The public
 * surface the member web app's SSR schedule page renders: published sessions
 * with real availability and the fixed v1 credit cost, ZERO attendee data.
 *
 * The shapes mirror public.member_schedule (migration 0043) exactly — the
 * function's locked return columns ARE the security boundary, and this schema
 * is the second, independent strip at the API boundary.
 */

/** Anti-abuse bound: an anonymous window may not exceed 45 days. */
export const MEMBER_SCHEDULE_MAX_WINDOW_DAYS = 45;

export const memberScheduleQuery = z
  .object({
    /** The PUBLIC tenant uuid (client env KELO_TENANT_ID; no Supabase material client-side). */
    tenant: z.string().uuid(),
    /** Window start, inclusive — ISO 8601 instant. */
    from: z.string().datetime({ offset: true }),
    /** Window end, exclusive — ISO 8601 instant. */
    to: z.string().datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (to <= from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be after from",
      });
    }
    if ((to - from) / 86_400_000 > MEMBER_SCHEDULE_MAX_WINDOW_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `schedule window may not exceed ${MEMBER_SCHEDULE_MAX_WINDOW_DAYS} days`,
      });
    }
  });
export type MemberScheduleQuery = z.infer<typeof memberScheduleQuery>;

/** One published session, exactly the 0043 allowlist — no person data exists here. */
export const memberScheduleItemSchema = z.object({
  session_id: z.string().uuid(),
  offering_name: z.string().min(1),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  capacity: z.number().int(),
  available: z.number().int(),
  readiness_ok: z.boolean(),
  /**
   * The v1 cost model is FIXED: app.book_session debits exactly ONE credit
   * (migration 0040), so every session costs 1 credit. There is deliberately
   * NO cash price — drop-in pricing is deferred to a later wave.
   */
  credit_cost: z.number().int(),
});
export type MemberScheduleItem = z.infer<typeof memberScheduleItemSchema>;

export const memberScheduleResponse = z.array(memberScheduleItemSchema);
export type MemberScheduleResponse = z.infer<typeof memberScheduleResponse>;

// ---------------------------------------------------------------------------
// Unit 8.2b — member AUTH (plan-member-app §3.2/§3.3). OTP start/verify +
// session minting. Anti-enumeration is BY CONSTRUCTION: /auth/start always
// does identical work and returns the same neutral 202 shape; /auth/verify
// failure is ONE neutral shape for unknown-contact/wrong-code/expired/locked
// (app.consume_member_otp, migration 0044, is the only verdict path).
// ---------------------------------------------------------------------------

/** Where the session will live — drives cookie (web) vs in-body token (mobile). */
export const memberPlatformSchema = z.enum(["web", "ios", "android"]);
export type MemberPlatform = z.infer<typeof memberPlatformSchema>;

export const memberAuthStartBody = z.object({
  /** The PUBLIC tenant uuid (client env KELO_TENANT_ID; no Supabase material). */
  tenant: z.string().uuid(),
  /** Email or US phone, as typed — normalized server-side (email lc / E.164). */
  contact: z.string().min(1).max(320),
});
export type MemberAuthStartBody = z.infer<typeof memberAuthStartBody>;

/** The neutral /auth/start body — IDENTICAL on hit, miss, staff, rate-limit. */
export const memberAuthStartResponse = z.object({
  sent: z.literal(true),
});
export type MemberAuthStartResponse = z.infer<typeof memberAuthStartResponse>;

export const memberAuthVerifyBody = z.object({
  /** The PUBLIC tenant uuid (client env KELO_TENANT_ID; no Supabase material). */
  tenant: z.string().uuid(),
  /** The same contact the code was sent to (normalized server-side). */
  contact: z.string().min(1).max(320),
  /** The 6-digit OTP as typed. Hashed before it touches anything persistent. */
  code: z.string().min(1).max(16),
  platform: memberPlatformSchema,
  device_label: z.string().min(1).max(100).optional(),
});
export type MemberAuthVerifyBody = z.infer<typeof memberAuthVerifyBody>;

/**
 * The claim state a freshly verified session can be in. `needs_resolution`
 * sessions see FIRST-NAME-ONLY — balances never render pre-resolution (§3.3).
 */
export const memberClaimStatusSchema = z.enum(["active", "needs_resolution"]);
export type MemberClaimStatus = z.infer<typeof memberClaimStatusSchema>;

/**
 * The member view returned by a successful /auth/verify. Deliberately minimal:
 * first_name + claim state + session expiry, NO balances or bookings (those
 * arrive via the 8.2c+ session-scoped routes). `token` is present ONLY for
 * mobile platforms — web rides the host-only `kelo_member` cookie instead, so
 * the raw token is returned in-body exactly once per session (§3.2).
 */
export const memberAuthViewSchema = z.object({
  member: z.object({
    first_name: z.string().nullable(),
    claim_status: memberClaimStatusSchema,
  }),
  session: z.object({
    /** Rolling expiry (90 days, slid on activity) — ISO 8601 instant. */
    expires_at: z.string().datetime({ offset: true }),
    /** Hard 12-month cap — ISO 8601 instant. */
    absolute_expires_at: z.string().datetime({ offset: true }),
  }),
  token: z.string().optional(),
});
export type MemberAuthView = z.infer<typeof memberAuthViewSchema>;

// -- member booking (unit 8.3a) ----------------------------------------------

/** The channel a member booking rode in on — booked_via provenance ONLY, never
 * a security boundary (person scope always comes from the session). */
export const memberBookingPlatform = z.enum(["web", "ios", "android"]).default("web");

/** POST /member/holds — reserve a seat (person from the session). */
export const memberHoldBody = z.object({
  session_id: z.string().uuid(),
  platform: memberBookingPlatform,
});
export type MemberHoldBody = z.infer<typeof memberHoldBody>;

/** POST /member/bookings — book a session. A member always debits ONE credit
 * (comp is operator-only); a member with no credits gets 422 insufficient
 * credits and is routed to buy/pay (the Pay stage). No use_credit knob. */
export const memberBookBody = z.object({
  session_id: z.string().uuid(),
  hold_id: z.string().uuid().nullish(),
  platform: memberBookingPlatform,
});
export type MemberBookBody = z.infer<typeof memberBookBody>;

/** POST /member/bookings/:id/cancel — 12h refund-vs-forfeit is enforced in the RPC. */
export const memberCancelBody = z.object({
  platform: memberBookingPlatform,
});
export type MemberCancelBody = z.infer<typeof memberCancelBody>;

/** POST /member/waitlist — join a FULL session's waitlist (FIFO position). */
export const memberWaitlistBody = z.object({
  session_id: z.string().uuid(),
  platform: memberBookingPlatform,
});
export type MemberWaitlistBody = z.infer<typeof memberWaitlistBody>;

// -- member account (unit 8.3b) ----------------------------------------------

/** GET /member/account — the signed-in member's live credit balance, waiver
 * status, and active bookings. Session start times are resolved client-side
 * from /member/schedule (no other attendee's session data is exposed here). */
export const memberAccountSchema = z.object({
  credit_balance: z.number().int(),
  waiver: z.object({ needs_signature: z.boolean() }),
  bookings: z.array(
    z.object({
      booking_id: z.string().uuid(),
      session_id: z.string().uuid(),
      status: z.string(),
    }),
  ),
});
export type MemberAccount = z.infer<typeof memberAccountSchema>;

// -- member claim status (unit 8.3c) -----------------------------------------

/** GET /member/claim/status — the ONE endpoint a needs_resolution session can
 * reach: its own claim status + first name (§3.3). No balances/bookings. */
export const memberClaimStatusView = z.object({
  claim_status: z.enum(["active", "needs_resolution", "frozen", "revoked"]),
  first_name: z.string().nullable(),
});
export type MemberClaimStatusView = z.infer<typeof memberClaimStatusView>;

// -- member booking responses (units 8.3a/8.3b — member-core validates these) --

export const memberHoldResponse = z.object({
  hold: z.object({
    id: z.string().uuid(),
    expires_at: z.string().nullable(),
    frozen: z.boolean(),
  }),
});
export const memberBookResponse = z.object({
  booking: z.object({ booking_id: z.string().uuid(), replayed: z.boolean().optional() }),
});
export const memberCancelResponse = z.object({
  cancellation: z.object({
    booking_id: z.string().uuid(),
    status: z.string(),
    branch: z.enum(["refund", "forfeit"]).nullable(),
    refunded: z.boolean(),
  }),
});
export const memberWaitlistResponse = z.object({
  waitlist: z.object({ position: z.number().int().positive() }),
});

/** POST /member/auth/logout — revoke THIS session; the API also clears the
 * host-only cookie. Idempotent. */
export const memberLogoutResponse = z.object({ revoked: z.boolean() });
