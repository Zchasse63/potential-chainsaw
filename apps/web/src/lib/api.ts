import { errorResponseSchema } from "@kelo/contracts";
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
 * GET an envelope-carrying endpoint with the Supabase access token as a
 * Bearer header (the same header apps/api/src/middleware/auth.ts verifies).
 * Non-2xx → ApiRequestError carrying the structured error's correlation id.
 */
export async function fetchEnvelope(path: string, accessToken: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
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
