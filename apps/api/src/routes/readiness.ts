import type { Hono } from "hono";
import { z } from "zod";
import {
  STAGE_DEFS,
  computeAllGates,
  computeGate,
  fetchGateAcks,
  gateDef,
  isGateKey,
  writeGateAck,
  type ComputedGate,
  type GateAck,
  type GateKey,
} from "../data-readiness.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody } from "../validate.js";

// Readiness aggregates native + glofox-derived + stripe-derived inputs, so the
// envelope source is honestly "mixed"; the per-gate as_of lives in each gate's
// evidence (the top-level meta.as_of is response time, per the envelope helper).
const provenance = { source: "mixed" as const, definitionVersion: "readiness:v1" };

// A gate is "blocking" only when it FAILS. Soft gates never fail; the sole hard
// gate that warns (roles_assigned, single-operator) is intentionally NON-blocking
// — a single operator may launch. Acknowledge ≠ resolve: a warn stays a warn.
function isBlocking(status: ComputedGate["status"]): boolean {
  return status === "fail";
}

const ackBody = z.object({
  gate_key: z.string().min(1),
  note: z.string().trim().min(1).max(1000),
});

export function registerReadinessRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // -- GET /readiness (owner/manager) ---------------------------------------
  // Computes every gate from REAL data (never self-report) and derives the five
  // UX §G stages. All reads run under the caller's RLS-scoped client.
  app.get("/readiness", requireAuth(deps), resolveTenant, requireRole("owner", "manager"), async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);

    const [computed, acks] = await Promise.all([
      computeAllGates(userClient, tenantId),
      fetchGateAcks(userClient, tenantId),
    ]);

    const statusByKey = new Map(computed.map((g) => [g.key, g.status]));

    const gates = computed.map((g) => {
      const ack = acks.get(g.key);
      return {
        key: g.key,
        hard: g.hard,
        status: g.status,
        evidence: g.evidence,
        acknowledged: ack ?? null,
      };
    });

    const stages = STAGE_DEFS.map((stage) => ({
      key: stage.key,
      label: stage.label,
      gate_keys: stage.gateKeys,
      complete: stage.gateKeys.every((key) => !isBlocking(statusByKey.get(key) ?? "fail")),
    }));

    return c.json(c.var.ok({ gates, stages }, provenance), 200);
  });

  // -- POST /readiness/ack (owner only) -------------------------------------
  // Acknowledging a NON-HARD warn gate writes an append-only audit_events row —
  // the ack IS the audit note. Only soft warn gates are acknowledgeable: hard
  // gates (422 gate_not_acknowledgeable) must be RESOLVED, not waved through, and
  // a gate not currently in 'warn' (422 gate_not_in_warn_state) has nothing to
  // acknowledge. Acknowledge ≠ resolve: the gate's status is unchanged.
  app.post(
    "/readiness/ack",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner"),
    requireIdempotencyKey,
    async (c) => {
      const body = await parseBody(c, ackBody);
      const { userClient, userId } = authOf(c);
      const { tenantId, role } = tenantOf(c);

      if (!isGateKey(body.gate_key)) {
        throw new ApiError(422, "unknown_gate", `unknown readiness gate: ${body.gate_key}`);
      }
      const gateKey: GateKey = body.gate_key;
      const def = gateDef(gateKey);
      if (def === undefined || def.hard) {
        throw new ApiError(
          422,
          "gate_not_acknowledgeable",
          "hard launch gates cannot be acknowledged — resolve them",
        );
      }

      const result = await computeGate(userClient, tenantId, gateKey);
      if (result.status !== "warn") {
        throw new ApiError(
          422,
          "gate_not_in_warn_state",
          `gate ${gateKey} is '${result.status}', not 'warn' — nothing to acknowledge`,
        );
      }

      const ack: GateAck = await writeGateAck(userClient, {
        tenantId,
        actorUserId: userId,
        actorRole: role,
        gateKey,
        note: body.note,
      });

      return c.json(c.var.ok({ gate_key: gateKey, acknowledged: ack }, provenance), 201);
    },
  );
}
