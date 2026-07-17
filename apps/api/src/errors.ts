import type { ErrorResponse } from "@kelo/contracts";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

/**
 * An error that maps directly onto a structured ErrorResponse
 * (contracts/envelope.ts) with a NON-200 status — errors are never
 * 200-with-failure (plan-final §3).
 */
export class ApiError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 401 — missing or invalid Bearer token (requireAuth). */
export class AuthError extends ApiError {
  constructor(message: string) {
    super(401, "unauthorized", message);
    this.name = "AuthError";
  }
}

/**
 * 403 (or 400 for a malformed/disallowed tenant header) — raised ONLY by the
 * tenant-resolution middleware, the sole source of tenant ids (threat model §1).
 */
export class TenantError extends ApiError {
  constructor(message: string, status: 400 | 403 = 403, code = "tenant_resolution_failed") {
    super(status, code, message);
    this.name = "TenantError";
  }
}

/** Build the contracts ErrorResponse body. */
export function errorBody(
  code: string,
  message: string,
  correlationId: string,
  details?: unknown,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      correlation_id: correlationId,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
