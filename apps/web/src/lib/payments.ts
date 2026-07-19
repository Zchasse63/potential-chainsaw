import { postEnvelope } from "./api.js";
import { inspectEnvelope } from "./envelope.js";

/**
 * The typed payments client (unit 5.8). Every payment/refund shape the web
 * surface consumes lives HERE so a server-contract drift is a one-file change.
 * The screen is presentational and never imports this module directly — the
 * route composes these calls into the injected handlers.
 */

/** The six payment states (mirrors data-payments.paymentStatusSchema). The
 *  webhook-confirmed set is the authority; requires_payment/processing are the
 *  pre-confirmation states an optimistic UI is forbidden from inventing. */
export type PaymentStatus =
  | "requires_payment"
  | "processing"
  | "succeeded"
  | "failed"
  | "refunded"
  | "partially_refunded";

/** Server-derived tender — the browser renders it, never guesses it. */
export type Tender = "cash" | "stripe";

export interface Payment {
  id: string;
  customer_id: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  stripe_payment_intent_id: string | null;
  command_id: string | null;
  tender: Tender;
  created_at: string;
  updated_at: string;
}

/** GET /payments payload: the rows plus the tenant's refund step-up threshold. */
export interface PaymentsList {
  payments: Payment[];
  refund_step_up_cents: number;
}

export type DunningStage =
  | "grace_started"
  | "reminder_sent"
  | "final_notice"
  | "past_due";

export interface DunningRow {
  subscription_id: string;
  customer_id: string;
  person_id: string;
  person_name: string | null;
  plan_id: string;
  status: string;
  stage: DunningStage;
  grace_expires_at: string | null;
  current_period_end: string | null;
  occurred_at: string;
}

export interface DunningList {
  dunning: DunningRow[];
}

/** The 202 body the refund POST returns — the server's ACCEPTANCE of the
 *  pending refund command. It is NOT a status flip: the payment stays in its
 *  webhook-confirmed status until the inbox flips it. */
export interface RefundAccepted {
  command_id: string;
  payment_id: string;
  amount_cents: number;
  status: "pending";
}

export interface RefundInput {
  amountCents: number;
  reason: string | null;
  /** Present only when the amount is above the tenant threshold — rides the
   *  X-Step-Up-Grant header the refund route re-verifies. */
  grantToken?: string;
}

/** The step-up grant the refund ceremony passes upward (from POST
 *  /staff/step-up/verify). */
export interface StepUpGrant {
  grantToken: string;
  expiresAt: string;
}

const STEP_UP_GRANT_HEADER = "X-Step-Up-Grant";

/**
 * POST /payments/:id/refund. Above the threshold the caller supplies a
 * grantToken, sent as X-Step-Up-Grant; the server RE-VERIFIES it (client
 * assertion is never trusted). Returns the accepted-but-pending refund command,
 * never a flipped payment status.
 */
export async function requestRefund(
  accessToken: string,
  paymentId: string,
  input: RefundInput,
): Promise<RefundAccepted> {
  const headers =
    input.grantToken !== undefined && input.grantToken !== ""
      ? { [STEP_UP_GRANT_HEADER]: input.grantToken }
      : undefined;
  const response = await postEnvelope(
    `/payments/${paymentId}/refund`,
    accessToken,
    { amount_cents: input.amountCents, reason: input.reason },
    headers,
  );
  const inspection = inspectEnvelope<{ refund: RefundAccepted }>(response);
  if (!inspection.ok) {
    throw new Error("The refund response was missing its provenance record; nothing is shown.");
  }
  return inspection.data.refund;
}

/**
 * POST /staff/step-up/verify (context 'refund_over_threshold'). Exchanges the
 * manager PIN for the short-lived HMAC grant the refund route consumes. The PIN
 * never leaves this request; only the signed grant is retained.
 */
export async function verifyStepUp(
  accessToken: string,
  pin: string,
  context: string,
): Promise<StepUpGrant> {
  const response = await postEnvelope("/staff/step-up/verify", accessToken, { pin, context });
  const inspection = inspectEnvelope<{ grant_token: string; grant: { expires_at: string } }>(
    response,
  );
  if (!inspection.ok) {
    throw new Error("The step-up response was missing its provenance record; no grant is trusted.");
  }
  return { grantToken: inspection.data.grant_token, expiresAt: inspection.data.grant.expires_at };
}

/** The context string the refund step-up ceremony is scoped to (matches the
 *  server's REFUND_STEP_UP_CONTEXT). */
export const REFUND_STEP_UP_CONTEXT = "refund_over_threshold";
