/**
 * @kelo/member-core — the shared member-surface spine (plan-member-app §4.1).
 * One typed client + envelope handling + the error taxonomy, consumed by the
 * web app (apps/member) now and the mobile app later — so the surfaces cannot
 * drift from the API contracts or from each other.
 */
export { createMemberApiClient } from "./client.js";
export type {
  FetchImpl,
  FetchScheduleParams,
  FetchScheduleResult,
  MemberApiClient,
  MemberApiClientConfig,
} from "./client.js";
export type {
  StartAuthParams,
  StartAuthResult,
  VerifyAuthParams,
  VerifyAuthResult,
} from "./auth.js";
// Session-scoped booking client (units 8.3a/8.3b) — shared web + mobile.
export {
  holdSeat,
  bookSeat,
  cancelBooking,
  joinWaitlist,
  fetchAccount,
} from "./booking.js";
export type { Hold, Booking, Cancellation, MemberResult } from "./booking.js";
export { MemberApiError } from "./errors.js";
export type { MemberApiErrorKind } from "./errors.js";
