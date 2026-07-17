import { IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER } from "@kelo/contracts";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../errors.js";
import type { AppEnv } from "../types.js";

/**
 * Mutation hygiene (plan-final §3): every mutation requires a client-generated
 * `Idempotency-Key` header (422 if absent). SCAFFOLD: the key is required but
 * NOT yet persisted/deduped — the idempotency_keys table lands with money
 * (phase 5, invariant #5); then enforcement moves into the RPCs.
 */
export const requireIdempotencyKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(
      422,
      "idempotency_key_required",
      `${IDEMPOTENCY_KEY_HEADER} header is required on mutations`,
    );
  }
  await next();
};

/**
 * STUB (phase 5): entity-version `If-Match` precondition. Entity versions do
 * not exist yet — they land with money/booking writes; then updates compare
 * this header against the row version and 409 on mismatch. Until then this
 * only surfaces the header value so callers can thread it through.
 */
export function ifMatchVersion(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  return c.req.header(IF_MATCH_HEADER) ?? null;
}
