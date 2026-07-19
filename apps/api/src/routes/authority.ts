import type { Hono } from "hono";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { validateStepUpGrant } from "../auth/stepup.js";
import { AUTHORITY_DOMAINS, fetchAuthorityMatrix, flipAuthority } from "../data-authority.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody } from "../validate.js";

const native = { source: "native" as const, definitionVersion: "authority:v1" };

/** The step-up context a flip grant must carry (4.1 grant mechanism; this unit). */
export const AUTHORITY_FLIP_STEP_UP_CONTEXT = "authority_flip";
/** Client-supplied owner assertion for a cutover flip (mirrors the refund route). */
export const STEP_UP_GRANT_HEADER = "x-step-up-grant";

const flipBody = z.object({
  domain: z.enum(AUTHORITY_DOMAINS),
  authority: z.enum(["glofox", "kelo"]),
  reason: z.string().trim().min(1).max(2000),
  evidence_url: z.string().trim().url().max(2000).nullable().optional(),
});

function requireStepUpSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.STEP_UP_SECRET;
  if (secret === undefined || Buffer.byteLength(secret) < 32) {
    throw new Error("STEP_UP_SECRET is missing or shorter than 32 bytes");
  }
  return secret;
}

/** The client Idempotency-Key, guaranteed present by requireIdempotencyKey. */
function idempotencyKeyOf(c: { req: { header: (name: string) => string | undefined } }): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(422, "idempotency_key_required", `${IDEMPOTENCY_KEY_HEADER} header is required`);
  }
  return key;
}

/**
 * The AUTHORITY MATRIX routes (Phase 7 · unit 7.1a; plan-final §4 step 4).
 *
 * GET /authority — the full matrix (all eight domains, Glofox-defaulted) for the
 * resolved tenant; owner/manager may READ the launch-readiness surface.
 *
 * POST /authority/flip — the cutover lever. OWNER ONLY, and additionally gated by
 * a valid OWNER step-up grant (the 4.1 HMAC mechanism, context 'authority_flip')
 * because a flip re-homes a whole capability domain — a shared-device identity
 * proof beyond the session. The client Idempotency-Key threads into the RPC so a
 * retried flip appends exactly one row. The definer RPC re-verifies OWNER role
 * in-body and writes the append-only ledger + an audit_events row.
 *
 * `env` supplies STEP_UP_SECRET; tests inject it, mirroring the refund route.
 */
export function registerAuthorityRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // -- read the matrix (owner/manager) ---------------------------------------
  app.get(
    "/authority",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      const matrix = await fetchAuthorityMatrix(userClient, tenantId);
      return c.json(c.var.ok({ matrix }, native), 200);
    },
  );

  // -- flip a domain's authority (owner ONLY + step-up + idempotency) --------
  app.post(
    "/authority/flip",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner"),
    requireIdempotencyKey,
    async (c) => {
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);

      // The step-up gate: a valid OWNER grant scoped to THIS user/tenant and the
      // 'authority_flip' context is mandatory (a refund grant cannot flip — the
      // context is bound into the HMAC). Checked before the body work.
      const token = c.req.header(STEP_UP_GRANT_HEADER);
      const grant =
        token !== undefined && token !== ""
          ? validateStepUpGrant(token, requireStepUpSecret(env), Date.now(), {
              sub: userId,
              tenant: tenantId,
              context: AUTHORITY_FLIP_STEP_UP_CONTEXT,
            })
          : null;
      if (grant === null) {
        throw new ApiError(
          401,
          "step_up_required",
          "an owner step-up grant is required to flip a domain's authority",
        );
      }

      const body = await parseBody(c, flipBody);
      const flipId = await flipAuthority(userClient, {
        tenantId,
        domain: body.domain,
        authority: body.authority,
        reason: body.reason,
        evidenceUrl: body.evidence_url ?? null,
        actorId: userId,
        idempotencyKey: idempotencyKeyOf(c),
      });
      return c.json(
        c.var.ok(
          { flip: { id: flipId, domain: body.domain, authority: body.authority } },
          native,
        ),
        201,
      );
    },
  );
}
