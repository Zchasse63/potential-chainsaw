import { errorResponseSchema, IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { API_BASE_URL } from "./env.js";

/**
 * Thin fetch client for the one Hono API (apps/api, base path /api/v1).
 * Success bodies are returned as UNKNOWN — DataBoundary owns the
 * provenance-or-nothing check; callers never trust a payload blindly.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | undefined;

  constructor(status: number, code: string, message: string, correlationId: string | undefined) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

/**
 * Shared request path: Bearer auth, structured-error mapping (non-2xx →
 * ApiRequestError carrying the correlation id), success body as unknown.
 */
async function requestEnvelope(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiRequestError(
      0,
      "network_error",
      "The request never reached the API — check the network connection.",
      undefined,
    );
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = errorResponseSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiRequestError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.correlation_id,
      );
    }
    throw new ApiRequestError(
      response.status,
      "http_error",
      `The API returned HTTP ${response.status} without a structured error.`,
      undefined,
    );
  }

  return (await response.json()) as unknown;
}

/**
 * GET an envelope-carrying endpoint with the Supabase access token as a
 * Bearer header (the same header apps/api/src/middleware/auth.ts verifies).
 */
export async function fetchEnvelope(path: string, accessToken: string): Promise<unknown> {
  return requestEnvelope(path, accessToken);
}

/**
 * POST a mutation. Every mutation carries a client-generated Idempotency-Key
 * (plan-final §3; apps/api/src/middleware/mutation.ts 422s without one). The
 * caller decides what to do with the confirmed envelope — NO optimistic
 * success anywhere on mutation paths (money-action discipline).
 */
export async function postEnvelope(
  path: string,
  accessToken: string,
  body: unknown,
): Promise<unknown> {
  return requestEnvelope(path, accessToken, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}
