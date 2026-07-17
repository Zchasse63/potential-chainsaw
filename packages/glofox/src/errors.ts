/**
 * Error family of the shared Glofox client (docs/glofox/README.md §3).
 * Callers (the sync jobs) branch on these types: auth failure pauses imports,
 * rate-limit/5xx are transient, success-false and Zod failures quarantine.
 */

/** Max chars of a response body kept on an error — context, never the payload. */
export const BODY_SNIPPET_MAX = 200;

/** Non-2xx HTTP status from Glofox. */
export class GlofoxHttpError extends Error {
  readonly status: number;
  /** The endpoint PATH (no query string, no credentials). */
  readonly endpoint: string;
  /** First ≤200 chars of the response body. */
  readonly bodySnippet: string;

  constructor(status: number, endpoint: string, bodySnippet: string, message?: string) {
    super(message ?? `Glofox HTTP ${status} on ${endpoint}: ${bodySnippet}`);
    this.name = "GlofoxHttpError";
    this.status = status;
    this.endpoint = endpoint;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * 401/403 — THE IMPORT-PAUSE SIGNAL: credentials are dead or rotated. Callers
 * set `sync_state.health_state = 'paused_auth_failed'` (migration 0006) and
 * stop hammering until a human re-enters credentials. NEVER retried.
 */
export class GlofoxAuthError extends GlofoxHttpError {
  constructor(status: number, endpoint: string, bodySnippet: string) {
    super(
      status,
      endpoint,
      bodySnippet,
      `Glofox auth failure (HTTP ${status}) on ${endpoint} — pause imports ` +
        `(sync_state.health_state = 'paused_auth_failed'): ${bodySnippet}`,
    );
    this.name = "GlofoxAuthError";
  }
}

/** 429 — the 10 req/s budget was exceeded. Retried with backoff by the client. */
export class GlofoxRateLimitError extends GlofoxHttpError {
  /** Parsed Retry-After header, milliseconds, when the vendor sent one. */
  readonly retryAfterMs?: number;

  constructor(endpoint: string, bodySnippet: string, retryAfterMs?: number) {
    super(429, endpoint, bodySnippet, `Glofox rate limit (HTTP 429) on ${endpoint}`);
    this.name = "GlofoxRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * TRAP 1 (vendor-acknowledged, README §3): older endpoints return HTTP 200
 * with `success: false`. Thrown whenever a parsed 2xx body carries
 * `success !== true` — Kelo never represents an error as a 200. Style C
 * (Analytics) bodies have NO `success` field, so this check does not apply to
 * them by construction.
 */
export class GlofoxSuccessFalseError extends Error {
  readonly endpoint: string;
  readonly bodySnippet: string;

  constructor(endpoint: string, bodySnippet: string) {
    super(`Glofox returned HTTP 200 with success !== true on ${endpoint} (trap 1): ${bodySnippet}`);
    this.name = "GlofoxSuccessFalseError";
    this.endpoint = endpoint;
    this.bodySnippet = bodySnippet;
  }
}
