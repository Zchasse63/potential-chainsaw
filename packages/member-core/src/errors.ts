/**
 * The member API error taxonomy (plan-member-app §4.1 — envelope handling and
 * typed errors live in member-core, once, for every surface). Every client
 * method returns `{ ok: false, error }` with one of these kinds; surfaces
 * branch on `kind`, never on message text.
 *
 *   invalid_params   — the call itself was malformed (caught by the Zod query
 *                      contract before any network I/O)
 *   network_error    — fetch rejected (offline, DNS, aborted)
 *   http_error       — a non-2xx status came back (carries `status`)
 *   envelope_invalid — a 2xx body WITHOUT schema-valid freshness meta; this is
 *                      a provenance defect (CLAUDE.md invariant #3), never
 *                      rendered
 *   shape_invalid    — the envelope's data failed the route's Zod contract
 *                      (or the body wasn't JSON at all)
 */
export type MemberApiErrorKind =
  | "invalid_params"
  | "network_error"
  | "http_error"
  | "envelope_invalid"
  | "shape_invalid";

export class MemberApiError extends Error {
  readonly kind: MemberApiErrorKind;
  /** HTTP status for kind "http_error"; undefined otherwise. */
  readonly status?: number;
  /**
   * The API's structured error code (`error.code` in the body) for kind
   * "http_error" — e.g. "session_at_capacity", "insufficient_credits",
   * "booking_waiver_required". Surfaces branch on THIS, not on `status` alone,
   * because one status can carry several conditions (409 is both the capacity
   * ceiling and an idempotency-key conflict). Undefined when no code was parseable.
   */
  readonly code?: string;

  constructor(
    kind: MemberApiErrorKind,
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MemberApiError";
    this.kind = kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.code !== undefined) {
      this.code = options.code;
    }
  }
}
