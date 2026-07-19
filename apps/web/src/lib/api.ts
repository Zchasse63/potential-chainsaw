import { ApiRequestError, errorResponseSchema, IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { API_BASE_URL } from "./env.js";

/**
 * Thin fetch client for the one Hono API (apps/api, base path /api/v1).
 * Success bodies are returned as UNKNOWN — DataBoundary owns the
 * provenance-or-nothing check; callers never trust a payload blindly.
 */

// Wave 8.1b: the error CLASS lives in @kelo/contracts (its shape is the
// contract's); only the env-dependent client around it stays here.
export { ApiRequestError };

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
 *
 * `idempotencyKey` is OPTIONAL: low-risk flows omit it and get a fresh random
 * key per HTTP attempt. MONEY flows (POS checkout, gift-card redeem, refund)
 * MUST pass ONE key per user intent, reused across retries of that intent — a
 * timeout-after-commit + retry with a fresh key would otherwise write a SECOND
 * order/charge. The explicit key is set here so a caller-supplied extraHeader
 * can never accidentally shadow it.
 */
export async function postEnvelope(
  path: string,
  accessToken: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
  idempotencyKey?: string,
): Promise<unknown> {
  return requestEnvelope(path, accessToken, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(extraHeaders ?? {}),
      [IDEMPOTENCY_KEY_HEADER]: idempotencyKey ?? crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

/**
 * PATCH a mutation. Same money-action discipline as postEnvelope: every
 * mutation carries a client-generated Idempotency-Key (the API enforces
 * requireIdempotencyKey, 422ing without it), and there is NO optimistic
 * success — the caller reflects the change only after the confirmed envelope
 * returns. Used for in-place catalog + authoring edits. `idempotencyKey` is
 * optional with the same per-intent contract as postEnvelope.
 */
export async function patchEnvelope(
  path: string,
  accessToken: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  return requestEnvelope(path, accessToken, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      [IDEMPOTENCY_KEY_HEADER]: idempotencyKey ?? crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}
