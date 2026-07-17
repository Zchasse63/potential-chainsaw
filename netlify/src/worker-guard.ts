import { assertWorkerSecret } from "@kelo/workers";

export const WORKER_SECRET_HEADER = "x-kelo-worker-secret";

/**
 * Pure guard for publicly addressable worker endpoints (threat model §6:
 * Netlify Background Functions are HTTP URLs anyone can POST to).
 *
 * Returns null when the invocation may proceed, or a 401 Response when the
 * shared secret is missing/mismatched/unconfigured. Call it BEFORE anything
 * else; past the guard, workers act ONLY on rows claimed from the jobs queue —
 * request-supplied parameters are never trusted.
 */
export function guardWorkerSecret(
  headers: Pick<Headers, "get">,
  expectedSecret: string | undefined,
): Response | null {
  try {
    assertWorkerSecret(headers.get(WORKER_SECRET_HEADER) ?? undefined, expectedSecret);
  } catch {
    return new Response(
      JSON.stringify({
        error: { code: "unauthorized", message: "missing or invalid worker secret" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  return null;
}
