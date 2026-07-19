import type { Hono } from "hono";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import {
  bookSession,
  cancelBooking,
  fetchSessionAvailability,
  freezeHold,
  releaseHold,
  holdSession,
} from "../data-bookings.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { persistIdempotency, requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams, parseQuery } from "../validate.js";

const idParams = z.object({ id: z.string().uuid() });

// A hold reserves a seat for a bounded window; the RPC caps the TTL at 3600s and
// defaults to 300s when omitted.
const holdBody = z.object({
  session_id: z.string().uuid(),
  person_id: z.string().uuid(),
  ttl_seconds: z.number().int().positive().max(3600).optional(),
});

// The desk booking body. p_via is fixed to 'desk' at the route (the member
// surfaces populate member_* in a later phase). A live hold, when supplied,
// reserves the seat; use_credit defaults true (a booking costs one credit).
const bookBody = z.object({
  session_id: z.string().uuid(),
  person_id: z.string().uuid(),
  hold_id: z.string().uuid().nullable().optional(),
  use_credit: z.boolean().optional(),
});

// An ISO-8601 instant window for the availability read.
const isoInstant = z.string().datetime({ offset: true });
const availabilityQuery = z
  .object({ from: isoInstant, to: isoInstant })
  .superRefine((value, ctx) => {
    if (Date.parse(value.from) >= Date.parse(value.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
    }
  });

const native = { source: "native" as const, definitionVersion: "bookings:v1" };

/** The client Idempotency-Key, guaranteed present by the mutation middleware. */
function idempotencyKeyOf(c: { req: { header: (name: string) => string | undefined } }): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(422, "idempotency_key_required", `${IDEMPOTENCY_KEY_HEADER} header is required`);
  }
  return key;
}

/**
 * The native booking-engine routes (Phase 6 · unit 6.1; invariants #5/#6).
 *
 * Every mutation runs requireAuth → resolveTenant (the SOLE tenant source) →
 * requireRole(owner|manager|front_desk) → an idempotency guard, then calls a
 * definer Postgres RPC (hold / freeze / book / cancel) that serializes on the
 * session row, ENFORCES the waiver, and moves credits ONLY as append-only ledger
 * entries. There is NO optimistic booking UI and NO client write path to
 * bookings/booking_holds — the RPC is the authority.
 *
 * The two MONEY-adjacent mutations (book debits a credit; cancel may refund one)
 * use persistIdempotency and thread the client Idempotency-Key straight into the
 * RPC's key param, so request-level and ledger-level idempotency share it: a
 * retried booking replays the stored response AND cannot append a second debit.
 * hold/freeze are seat-reservation only (no ledger write) and take the light
 * header guard — hold is self-idempotent via the one-live-hold upsert.
 *
 * `createBillingClient` is the service-role seam persistIdempotency uses to
 * reserve/store/release the idempotency_keys row (member-SELECT RLS; the service
 * role writes). Tests inject a no-network fake, mirroring the payments routes.
 */
export function registerBookingRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  createBillingClient: () => KeloSupabaseClient = createServiceRoleClient,
): void {
  // -- availability read (member) --------------------------------------------
  // SECURITY INVOKER: RLS scopes the read to the caller's tenant, so a foreign
  // window simply yields zero rows. Any active member may read the picker.
  app.get("/sessions/availability", requireAuth(deps), resolveTenant, async (c) => {
    const { from, to } = parseQuery(c, availabilityQuery);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const sessions = await fetchSessionAvailability(userClient, tenantId, from, to);
    return c.json(c.var.ok({ sessions }, native), 200);
  });

  // -- reserve a seat (owner/manager/front_desk) -----------------------------
  app.post(
    "/bookings/hold",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    requireIdempotencyKey,
    async (c) => {
      const body = await parseBody(c, holdBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const hold = await holdSession(userClient, {
        tenantId,
        sessionId: body.session_id,
        personId: body.person_id,
        actorId: userId,
        ttlSeconds: body.ttl_seconds ?? 300,
      });
      return c.json(c.var.ok({ hold }, native), 201);
    },
  );

  // -- freeze a hold's expiry (payment initiation; owner/manager/front_desk) --
  // :id is the HOLD id. Freezing stops the sweep from reclaiming the seat while
  // tender is mid-flight (plan-ux §3D). Self-idempotent (sets frozen=true).
  app.post(
    "/bookings/:id/freeze-hold",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    requireIdempotencyKey,
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      await freezeHold(userClient, { tenantId, holdId: id });
      return c.json(c.var.ok({ hold: { id, frozen: true } }, native), 200);
    },
  );

  // -- release a hold (REVIEW FIX 6.1-crit-2: frozen holds must not be immortal) --
  // :id is the HOLD id. The operator remediation for an abandoned tender (card
  // declined, member walked away): deletes the hold REGARDLESS of frozen — the
  // only path besides book_session's consume that removes a frozen hold.
  app.post(
    "/bookings/:id/release-hold",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    requireIdempotencyKey,
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const released = await releaseHold(userClient, { tenantId, holdId: id, actorId: userId });
      return c.json(c.var.ok({ hold: { id, released } }, native), 200);
    },
  );

  // -- book a session (owner/manager/front_desk; debits one credit) ----------
  // The RPC enforces the waiver (needs_signature → 403 booking_waiver_required),
  // debits ONE credit as a negative append-only ledger entry keyed on the client
  // Idempotency-Key, and consumes any supplied hold. persistIdempotency replays a
  // retried request verbatim; the shared key also blocks a second ledger debit.
  app.post(
    "/bookings",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const body = await parseBody(c, bookBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const booking = await bookSession(userClient, {
        tenantId,
        personId: body.person_id,
        sessionId: body.session_id,
        actorId: userId,
        idempotencyKey: idempotencyKeyOf(c),
        via: "desk",
        holdId: body.hold_id ?? null,
        useCredit: body.use_credit ?? true,
      });
      return c.json(c.var.ok({ booking }, native), 201);
    },
  );

  // -- cancel a booking (owner/manager/front_desk; refund vs forfeit) ---------
  // The RPC applies the studio policy: ≥12h before start → refund (a positive
  // append-only refund_credit entry); <12h → forfeit (the debit stands). p_now is
  // the API's now(); the RPC keeps the 12h boundary a pure function of it.
  // persistIdempotency + the shared key make a retried cancel replay, never
  // double-refund.
  app.post(
    "/bookings/:id/cancel",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const { id } = parseParams(c, idParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const cancellation = await cancelBooking(userClient, {
        tenantId,
        bookingId: id,
        actorId: userId,
        idempotencyKey: idempotencyKeyOf(c),
        now: new Date().toISOString(),
      });
      return c.json(c.var.ok({ cancellation }, native), 200);
    },
  );
}
