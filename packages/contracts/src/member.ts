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
