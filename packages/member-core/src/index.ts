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
export { MemberApiError } from "./errors.js";
export type { MemberApiErrorKind } from "./errors.js";
