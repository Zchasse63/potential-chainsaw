import type { Hono } from "hono";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import {
  acceptWaitlistOffer,
  checkIn,
  declineWaitlistOffer,
  fetchRoster,
  fetchWaitlistPosition,
  joinWaitlist,
} from "../data-booking.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { persistIdempotency } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams, parseQuery } from "../validate.js";

const native = { source: "native" as const, definitionVersion: "booking:v1" };

const joinBody = z.object({
  session_id: z.string().uuid(),
  person_id: z.string().uuid(),
});

const entryParams = z.object({ id: z.string().uuid() });
const bookingParams = z.object({ id: z.string().uuid() });
const sessionParams = z.object({ id: z.string().uuid() });

const positionQuery = z.object({
  session_id: z.string().uuid(),
  person_id: z.string().uuid(),
});

/** The client Idempotency-Key, guaranteed present by persistIdempotency. */
function idempotencyKeyOf(c: { req: { header: (name: string) => string | undefined } }): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(422, "idempotency_key_required", `${IDEMPOTENCY_KEY_HEADER} header is required`);
  }
  return key;
}

/**
 * The booking desk surface (phase 6 · unit 6.2: waitlist join/accept/decline,
 * position, check-in, roster). Every mutation runs requireAuth → resolveTenant
 * (SOLE tenant source, invariant #7) → requireRole (owner/manager/front_desk) →
 * persisted idempotency, then calls a definer Postgres RPC (app.join_waitlist /
 * app.accept_waitlist_offer / app.decline_waitlist_offer / app.check_in) that
 * re-checks tenancy + role in-body and threads the client Idempotency-Key. There
 * is NO client write path to waitlist_entries/bookings/booking_holds and NO
 * optimistic booking UI — the RPC is the authority (invariant #5). Reads (position,
 * roster) are ordinary member SELECTs through the user-scoped RLS client.
 *
 * `createBillingClient` is the service-role seam the persisted idempotency
 * middleware uses to reserve/store/replay the idempotency_keys row (member-SELECT
 * RLS; the service role writes). Tests inject a no-network fake.
 */
export function registerWaitlistRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  createBillingClient: () => KeloSupabaseClient = createServiceRoleClient,
): void {
  // -- join a FULL session's waitlist (FIFO position) -------------------------
  app.post(
    "/waitlist/join",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const body = await parseBody(c, joinBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const result = await joinWaitlist(userClient, {
        tenantId,
        actorId: userId,
        sessionId: body.session_id,
        personId: body.person_id,
        idempotencyKey: idempotencyKeyOf(c),
      });
      return c.json(c.var.ok({ waitlist: result }, native), 201);
    },
  );

  // -- accept an offer (books through app.book_session; waiver enforced there) -
  app.post(
    "/waitlist/:id/accept",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const { id } = parseParams(c, entryParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const result = await acceptWaitlistOffer(userClient, {
        tenantId,
        actorId: userId,
        entryId: id,
        idempotencyKey: idempotencyKeyOf(c),
        via: "desk",
      });
      return c.json(c.var.ok({ booking: result }, native), 201);
    },
  );

  // -- decline an offer (releases the hold; cascades to the next waiter) -------
  app.post(
    "/waitlist/:id/decline",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const { id } = parseParams(c, entryParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      await declineWaitlistOffer(userClient, { tenantId, actorId: userId, entryId: id });
      return c.json(c.var.ok({ declined: true }, native), 200);
    },
  );

  // -- honesty read: the member's true position + offer window ----------------
  app.get(
    "/waitlist/position",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    async (c) => {
      const q = parseQuery(c, positionQuery);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const position = await fetchWaitlistPosition(userClient, tenantId, q.session_id, q.person_id);
      return c.json(c.var.ok({ position }, native), 200);
    },
  );

  // -- desk check-in within the arrival window (idempotent re-check-in no-ops) -
  app.post(
    "/bookings/:id/check-in",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const { id } = parseParams(c, bookingParams);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const result = await checkIn(userClient, {
        tenantId,
        actorId: userId,
        bookingId: id,
        now: new Date().toISOString(),
      });
      return c.json(c.var.ok({ check_in: result }, native), 200);
    },
  );

  // -- roster: the session's active bookings + live waitlist (names under RLS) -
  app.get(
    "/sessions/:id/roster",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    async (c) => {
      const { id } = parseParams(c, sessionParams);
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const roster = await fetchRoster(userClient, tenantId, id);
      return c.json(c.var.ok({ roster }, native), 200);
    },
  );
}
