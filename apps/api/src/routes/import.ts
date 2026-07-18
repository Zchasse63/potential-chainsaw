import type { Hono } from "hono";
import { z } from "zod";
import {
  fetchQuarantine,
  fetchQuarantineCauses,
  fetchQuarantineItem,
  fetchReconciliations,
  insertAuditEvent,
  quarantineStatusSchema,
  resolveQuarantine,
  QUARANTINE_RESOLVE_MAX_IDS,
} from "../data.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams, parseQuery } from "../validate.js";

/**
 * Import review (plan-final §4 quarantine; UX plan §3G) — the operator's
 * window into import correctness. The whole surface is owner/manager work:
 * the review queue and its decisions are gated by requireRole("owner",
 * "manager"); front_desk/trainer get a structured 403, never the data.
 *
 * "Reversible until commit" (§3G) is a CLIENT concern: the web screen stages
 * a same-cause selection locally; the POST below IS the commit. Resolution is
 * FORWARD-ONLY in v1 — open → resolved | dismissed, never re-opened (see
 * resolveQuarantine in data.ts).
 */

const quarantineListQuerySchema = z.object({
  status: quarantineStatusSchema.optional(),
  entity: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime({ offset: true }).optional(),
});

const reconciliationsQuerySchema = z.object({
  entity: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const resolveBodySchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(QUARANTINE_RESOLVE_MAX_IDS),
    status: z.enum(["resolved", "dismissed"]),
    note: z.string().max(2000).optional(),
  })
  .refine((b) => b.status !== "dismissed" || (b.note !== undefined && b.note.trim() !== ""), {
    message:
      "a note is required when dismissing — it is the audit trail for why evidence was set aside",
  });

const idParamSchema = z.object({ id: z.string().uuid() });

export function registerImportRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // The review queue: exceptions grouped by cause (the batch-decision unit)
  // plus one keyset page of rows. `payload` stays out of the list — the
  // detail route below carries it.
  app.get(
    "/import/quarantine",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const query = parseQuery(c, quarantineListQuerySchema);

      const [causes, items] = await Promise.all([
        fetchQuarantineCauses(userClient, tenantId),
        fetchQuarantine(userClient, tenantId, query),
      ]);
      const last = items[items.length - 1];
      const nextCursor =
        items.length === query.limit && last !== undefined ? last.created_at : null;

      return c.json(c.var.ok({ causes, items, next_cursor: nextCursor }), 200);
    },
  );

  // One row WITH payload — the before/after "what came in" preview source.
  app.get(
    "/import/quarantine/:id",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const { id } = parseParams(c, idParamSchema);

      const item = await fetchQuarantineItem(userClient, tenantId, id);
      if (item === null) {
        throw new ApiError(404, "quarantine_not_found", "quarantine row not found");
      }
      return c.json(c.var.ok({ item }), 200);
    },
  );

  // THE COMMIT. One audit_events row per batch, actor stamped from the
  // verified session (never client input — Zod strips a forged actor field
  // unread). The response returns exactly the rows the server durably
  // changed; ids that were already decided or foreign simply don't appear.
  app.post(
    "/import/quarantine/resolve",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    requireIdempotencyKey,
    async (c) => {
      const { userId, userClient } = authOf(c);
      const { tenantId, role } = tenantOf(c);
      const body = await parseBody(c, resolveBodySchema);

      const updated = await resolveQuarantine(
        userClient,
        tenantId,
        body.ids,
        { status: body.status, note: body.note },
        userId,
      );
      await insertAuditEvent(userClient, {
        tenantId,
        actorUserId: userId,
        actorRole: role,
        action: "import.quarantine_resolved",
        targetType: "import_quarantine",
        metadata: { ids: body.ids, status: body.status },
      });
      return c.json(c.var.ok({ items: updated }), 200);
    },
  );

  // Reconciliation history (unit 1.5 owns the table — see the 42P01 bridge
  // in data.ts). Until that table exists this answers 200 with
  // reconciliation_pending: true (data AND meta), never a 500.
  app.get(
    "/import/reconciliations",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const query = parseQuery(c, reconciliationsQuerySchema);

      const result = await fetchReconciliations(userClient, tenantId, query);
      const body = c.var.ok({
        reconciliations: result.rows,
        reconciliation_pending: result.pending,
      });
      // The pinned bridge contract also carries the flag on meta. It is
      // additive — the contracts meta schema strips unknown keys client-side,
      // which is why data carries the same flag.
      if (result.pending) {
        return c.json({ ...body, meta: { ...body.meta, reconciliation_pending: true } }, 200);
      }
      return c.json(body, 200);
    },
  );
}
