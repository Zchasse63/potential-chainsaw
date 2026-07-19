import type { Hono } from "hono";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import { validateStepUpGrant } from "../auth/stepup.js";
import { fetchTenant } from "../data.js";
import { fetchDunningQueue } from "../data-dunning.js";
import {
  createPaymentIntent,
  createRefund,
  fetchPayment,
  fetchPayments,
  type PaymentRow,
} from "../data-payments.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { persistIdempotency } from "../middleware/mutation.js";
import { requireRole, resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody, parseParams } from "../validate.js";

const idParams = z.object({ id: z.string().uuid() });
const amountCents = z.number().int().positive().max(100_000_000);

const intentBody = z.object({
  customer_id: z.string().uuid(),
  amount_cents: amountCents,
  // A 3-letter ISO code; the RPC normalizes case and defaults to 'usd'.
  currency: z.string().length(3).optional(),
});
const refundBody = z.object({
  amount_cents: amountCents,
  reason: z.string().trim().min(1).max(500).nullable().optional(),
});

const native = { source: "native" as const, definitionVersion: "payments:v1" };

/** The step-up context the refund route consumes (4.1 grant mechanism, unit 5.4). */
export const REFUND_STEP_UP_CONTEXT = "refund_over_threshold";
/** Client-supplied manager assertion for above-threshold refunds. */
export const STEP_UP_GRANT_HEADER = "x-step-up-grant";
/** tenants.settings key + default: refunds at/under the threshold need no grant. */
const REFUND_THRESHOLD_SETTING = "refund_step_up_cents";
const DEFAULT_REFUND_THRESHOLD_CENTS = 10_000;

/** Resolve the tenant's refund step-up threshold (cents); default $100. */
function resolveRefundThreshold(settings: Record<string, unknown> | undefined): number {
  const raw = settings?.[REFUND_THRESHOLD_SETTING];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_REFUND_THRESHOLD_CENTS;
}

/**
 * Tender is DERIVED server-side (there is no tender column — a payment is an
 * event, invariant #6). A cash POS sale carries neither a Stripe outbox command
 * nor a payment-intent id; anything with either is a Stripe payment. The
 * browser renders this server-provided value — it never guesses tender from a
 * money row itself.
 */
function tenderOf(payment: PaymentRow): "cash" | "stripe" {
  return payment.command_id === null && payment.stripe_payment_intent_id === null
    ? "cash"
    : "stripe";
}

type PaymentView = PaymentRow & { tender: "cash" | "stripe" };
function withTender(payment: PaymentRow): PaymentView {
  return { ...payment, tender: tenderOf(payment) };
}

function requireStepUpSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.STEP_UP_SECRET;
  if (secret === undefined || Buffer.byteLength(secret) < 32) {
    throw new Error("STEP_UP_SECRET is missing or shorter than 32 bytes");
  }
  return secret;
}

/** The client Idempotency-Key, guaranteed present by persistIdempotency (422s otherwise). */
function idempotencyKeyOf(c: { req: { header: (name: string) => string | undefined } }): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key.trim() === "") {
    throw new ApiError(422, "idempotency_key_required", `${IDEMPOTENCY_KEY_HEADER} header is required`);
  }
  return key;
}

/**
 * The money-intent routes (invariant #5; threat-model §2). Every mutation runs
 * requireAuth → resolveTenant (SOLE tenant source) → requireRole → persisted
 * idempotency, then calls a Postgres RPC that WRITES an outbox command — NO
 * Stripe call, NO optimistic status flip. The client Idempotency-Key threads all
 * the way into the RPC so request-level and outbox-level idempotency share it: a
 * retried money request replays the stored response AND cannot write a second
 * command.
 *
 * `env` supplies STEP_UP_SECRET; `createBillingClient` is the service-role seam
 * the persisted idempotency middleware uses to reserve/store/release the
 * idempotency_keys row (member-SELECT RLS; the service role writes). Tests inject
 * a no-network fake for both, mirroring the webhook/step-up seams.
 */
export function registerPaymentRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  env: NodeJS.ProcessEnv = process.env,
  createBillingClient: () => KeloSupabaseClient = createServiceRoleClient,
): void {
  // -- reads (member) --------------------------------------------------------
  // The list carries each row's derived tender plus the tenant's refund step-up
  // threshold, so the web surface can decide when the manager PIN ceremony is
  // required WITHOUT a second round trip or a client-side default guess.
  app.get("/payments", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const [payments, tenant] = await Promise.all([
      fetchPayments(userClient, tenantId),
      fetchTenant(userClient, tenantId),
    ]);
    return c.json(
      c.var.ok(
        {
          payments: payments.map(withTender),
          refund_step_up_cents: resolveRefundThreshold(tenant?.settings),
        },
        native,
      ),
      200,
    );
  });

  // -- the dunning queue (owner/manager; unit 5.8 web surface) ----------------
  // Registered BEFORE /payments/:id so "dunning" is never parsed as an id.
  app.get(
    "/payments/dunning",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    async (c) => {
      const { userClient } = authOf(c);
      const { tenantId } = tenantOf(c);
      return c.json(
        c.var.ok({ dunning: await fetchDunningQueue(userClient, tenantId) }, native),
        200,
      );
    },
  );

  app.get("/payments/:id", requireAuth(deps), resolveTenant, async (c) => {
    const { id } = parseParams(c, idParams);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const payment = await fetchPayment(userClient, tenantId, id);
    if (payment === null) throw new ApiError(404, "payment_not_found", "payment not found");
    return c.json(c.var.ok({ payment: withTender(payment) }, native), 200);
  });

  // -- create a payment intent (owner/manager/front_desk take payments) ------
  // The RPC writes a payments row (requires_payment) + a pending outbox command;
  // the outbox processor later calls Stripe and the webhook confirms. The route
  // returns the PENDING payment — never a success claim before the provider.
  app.post(
    "/payments/intents",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager", "front_desk"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const body = await parseBody(c, intentBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const paymentId = await createPaymentIntent(userClient, {
        tenantId,
        customerId: body.customer_id,
        amountCents: body.amount_cents,
        currency: body.currency ?? "usd",
        idempotencyKey: idempotencyKeyOf(c),
        actorId: userId,
      });
      const payment = await fetchPayment(userClient, tenantId, paymentId);
      if (payment === null) {
        throw new Error("createPaymentIntent: payment vanished after insert");
      }
      return c.json(c.var.ok({ payment: withTender(payment) }, native), 201);
    },
  );

  // -- refund a succeeded payment (owner/manager; step-up above threshold) ----
  // Above the tenant's configured refund threshold, a valid manager step-up
  // grant (the 4.1 mechanism's first real consumer) is required. The RPC writes
  // a pending create_refund command and NEVER flips the payment status — the
  // webhook/inbox is the confirmation authority.
  app.post(
    "/payments/:id/refund",
    requireAuth(deps),
    resolveTenant,
    requireRole("owner", "manager"),
    persistIdempotency(createBillingClient),
    async (c) => {
      const { id } = parseParams(c, idParams);
      const body = await parseBody(c, refundBody);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);

      const tenant = await fetchTenant(userClient, tenantId);
      const threshold = resolveRefundThreshold(tenant?.settings);
      if (body.amount_cents > threshold) {
        const token = c.req.header(STEP_UP_GRANT_HEADER);
        const grant =
          token !== undefined && token !== ""
            ? validateStepUpGrant(token, requireStepUpSecret(env), Date.now(), {
                sub: userId,
                tenant: tenantId,
                context: REFUND_STEP_UP_CONTEXT,
              })
            : null;
        if (grant === null) {
          throw new ApiError(
            401,
            "step_up_required",
            "a manager step-up grant is required to refund above the configured threshold",
            { threshold_cents: threshold },
          );
        }
      }

      const commandId = await createRefund(userClient, {
        tenantId,
        paymentId: id,
        amountCents: body.amount_cents,
        idempotencyKey: idempotencyKeyOf(c),
        actorId: userId,
        reason: body.reason ?? null,
      });
      // 202: the refund is ACCEPTED and pending; the webhook confirms it and the
      // inbox flips the payment to refunded/partially_refunded. No optimistic
      // money status is returned.
      return c.json(
        c.var.ok(
          {
            refund: {
              command_id: commandId,
              payment_id: id,
              amount_cents: body.amount_cents,
              status: "pending" as const,
            },
          },
          native,
        ),
        202,
      );
    },
  );
}
