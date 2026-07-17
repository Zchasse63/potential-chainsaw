import { timingSafeEqual } from "node:crypto";

/**
 * Threat model §6: Netlify Background Functions are publicly addressable HTTP
 * URLs, so every worker invocation must present the internal shared secret.
 * The (next unit's) function handler calls this BEFORE touching the queue and
 * rejects unauthenticated invocations. Compared in constant time.
 *
 * Note: the secret gates INVOCATION, never work shape — workers act solely on
 * rows claimed from the jobs queue and ignore any request-supplied work
 * parameters.
 */
export function assertWorkerSecret(
  provided: string | undefined,
  expected: string | undefined,
): void {
  if (provided === undefined || provided === "" || expected === undefined || expected === "") {
    throw new Error("worker secret not configured or not provided");
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid worker secret");
  }
}
