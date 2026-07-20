/**
 * Wave 8 · unit 8.2a — member identity purge job kinds (migration 0044).
 *
 * KIND CONSTANTS ONLY. Both kinds drain on the ONE Netlify tick + Postgres
 * `jobs` queue (invariant #4 — no second scheduler). The processor bodies are
 * thin delegations to the guarded definer helpers shipped in 0044
 * (`select app.purge_member_otp_challenges($1)` / `select app.purge_member_sessions($1)`,
 * the `booking.expire_holds` shape); their `processors.ts` registration and
 * the cadenced fan-out enqueue land with the member auth unit (8.2b), which
 * owns the tables' writers.
 */

/** Deletes consumed/expired `member_otp_challenges` via app.purge_member_otp_challenges. */
export const MEMBER_OTP_PURGE_KIND = "member_otp_purge";

/** Deletes sessions past their absolute 12-month cap via app.purge_member_sessions. */
export const MEMBER_SESSION_PURGE_KIND = "member_session_purge";
