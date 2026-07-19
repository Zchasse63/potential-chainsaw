import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER } from "@kelo/contracts";
import type { KeloSupabaseClient } from "@kelo/db";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  storeIdempotentResponse,
} from "../data-billing.js";
import { ApiError } from "../errors.js";
import { tenantOf, type AppEnv } from "../types.js";

/** Set on a replayed response so a client (and logs) can tell it apart. */
export const IDEMPOTENT_REPLAY_HEADER = "Idempotent-Replay";

function requiredIdempotencyKey(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(
      422,
      "idempotency_key_required",
      `${IDEMPOTENCY_KEY_HEADER} header is required on mutations`,
    );
  }
  return key;
}

/**
 * Mutation hygiene (plan-final §3): every mutation requires a client-generated
 * `Idempotency-Key` header (422 if absent). This is the LIGHT guard — it checks
 * the header but does NOT persist/dedup. The existing non-money routes keep
 * using it unchanged; the money routes (phase 5) opt into `persistIdempotency`
 * below, which additionally reserves + replays the response.
 */
export const requireIdempotencyKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  requiredIdempotencyKey(c);
  await next();
};

/**
 * PERSISTED idempotency for money mutations (invariant #5). Runs AFTER
 * requireAuth + resolveTenant, so the tenant comes from membership, never the
 * body. Backed by `idempotency_keys` (migration 0033) through the injected
 * SERVICE client (member-SELECT RLS; the service role writes):
 *
 *   1. 422 if the header is absent (same as the light guard).
 *   2. request_hash = sha256(method + path + body). RESERVE a row before the
 *      handler runs.
 *   3. same key + same hash, response stored  → REPLAY it verbatim (the handler
 *      never runs, so the mutation never repeats).
 *   4. same key + DIFFERENT hash              → 409 idempotency_key_conflict.
 *   5. same key, still in flight              → 409 idempotency_key_in_progress.
 *   6. fresh → execute once. A 2xx/3xx is STORED under the key for replay; any
 *      error response (4xx/5xx) or a raw throw RELEASES the reservation so a
 *      legitimate retry proceeds (a double-charge is still impossible: the
 *      durable stripe_commands outbox keys the actual Stripe call on its own
 *      idempotency key).
 *
 * `createClient` is injected (tests pass a fake; production passes a
 * service-role client factory), mirroring the webhook/step-up client seams.
 */
export function persistIdempotency(
  createClient: () => KeloSupabaseClient,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = requiredIdempotencyKey(c);
    const { tenantId } = tenantOf(c);

    // Clone the raw request so the route handler's own c.req.json() still reads
    // an unconsumed body. The hash binds the key to method + path + body.
    const bodyText = await c.req.raw.clone().text();
    const requestHash = createHash("sha256")
      .update(`${c.req.method}\n${c.req.path}\n${bodyText}`)
      .digest("hex");

    const client = createClient();
    const reservation = await reserveIdempotencyKey(client, { tenantId, key, requestHash });

    if (reservation.outcome === "conflict") {
      throw new ApiError(
        409,
        "idempotency_key_conflict",
        `${IDEMPOTENCY_KEY_HEADER} was already used for a different request`,
      );
    }
    if (reservation.outcome === "in_progress") {
      throw new ApiError(
        409,
        "idempotency_key_in_progress",
        `a request with this ${IDEMPOTENCY_KEY_HEADER} is still in progress`,
      );
    }
    if (reservation.outcome === "replay") {
      c.header(IDEMPOTENT_REPLAY_HEADER, "true");
      return c.json(reservation.body ?? null, reservation.status as ContentfulStatusCode);
    }

    // outcome === "fresh": we hold the reservation; execute exactly once. When
    // the app has an onError handler (it does), a thrown handler resolves next()
    // with the mapped error response; the catch is the fallback for a raw throw.
    try {
      await next();
    } catch (err) {
      await releaseIdempotencyKey(client, { tenantId, key });
      throw err;
    }

    if (c.res.status >= 400) {
      // Only a durable success is replayable. Any error (validation, conflict,
      // authorization, or a 5xx) releases the reservation so a legitimate retry
      // proceeds — a double-charge stays impossible because the actual Stripe
      // call is keyed on the durable stripe_commands idempotency key.
      await releaseIdempotencyKey(client, { tenantId, key });
      return;
    }

    // Persist the response so a later replay returns it verbatim.
    const text = await c.res.clone().text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body is not part of the money surface and cannot be
        // replayed faithfully — release rather than store an unusable record.
        await releaseIdempotencyKey(client, { tenantId, key });
        return;
      }
    }
    await storeIdempotentResponse(client, { tenantId, key, status: c.res.status, body });
  };
}

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
