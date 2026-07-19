/**
 * Typed mapper from a raw Stripe event to a discriminated union the inbox
 * processor consumes. WIDEN-THEN-CLASSIFY (mirroring the `glofox_event`
 * discipline, CLAUDE.md invariant #8): every unknown or malformed event maps to
 * `{ kind: 'ignored', rawType }` — quarantine-by-ignore, NEVER throw. Only the
 * Phase-5 event types the pipeline acts on are classified; everything else is
 * durably recorded in the inbox and skipped.
 */

export type StripeEventAction =
  | {
      readonly kind: "payment_succeeded";
      readonly eventId: string;
      readonly paymentIntentId: string;
      readonly amount?: number;
      readonly currency?: string;
      readonly status?: string;
    }
  | {
      readonly kind: "payment_failed";
      readonly eventId: string;
      readonly paymentIntentId: string;
      readonly failureCode?: string;
      readonly failureMessage?: string;
    }
  | {
      readonly kind: "charge_refunded";
      readonly eventId: string;
      readonly chargeId: string;
      readonly paymentIntentId?: string;
      readonly amountRefunded?: number;
      readonly refunded?: boolean;
    }
  | {
      readonly kind: "subscription_updated";
      readonly eventId: string;
      readonly subscriptionId: string;
      readonly status?: string;
      readonly customerId?: string;
      /** Unix seconds; synced onto subscriptions.current_period_end. */
      readonly currentPeriodEnd?: number;
      /** True for customer.subscription.deleted — the inbox forces 'cancelled'. */
      readonly deleted?: boolean;
    }
  | {
      readonly kind: "invoice_payment_failed";
      readonly eventId: string;
      readonly invoiceId: string;
      readonly subscriptionId?: string;
      readonly customerId?: string;
      readonly attemptCount?: number;
    }
  | {
      readonly kind: "invoice_payment_succeeded";
      readonly eventId: string;
      readonly invoiceId: string;
      readonly subscriptionId?: string;
      readonly customerId?: string;
    }
  | { readonly kind: "ignored"; readonly eventId?: string; readonly rawType: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Classify a Stripe event. `event` is the parsed webhook body
 * (`{ id, type, data: { object } }`). Unknown types, and events missing an id
 * or a data.object, map to `{ kind: 'ignored', rawType }`.
 */
export function mapStripeEvent(event: unknown): StripeEventAction {
  const envelope = record(event);
  const rawType = str(envelope?.["type"]) ?? "";
  const eventId = str(envelope?.["id"]);
  const object = record(record(envelope?.["data"])?.["object"]);

  const ignored: StripeEventAction = { kind: "ignored", eventId, rawType };
  if (rawType === "" || eventId === undefined || object === undefined) return ignored;

  switch (rawType) {
    case "payment_intent.succeeded": {
      const paymentIntentId = str(object["id"]);
      if (paymentIntentId === undefined) return ignored;
      return {
        kind: "payment_succeeded",
        eventId,
        paymentIntentId,
        amount: num(object["amount"]),
        currency: str(object["currency"]),
        status: str(object["status"]),
      };
    }
    case "payment_intent.payment_failed": {
      const paymentIntentId = str(object["id"]);
      if (paymentIntentId === undefined) return ignored;
      const lastError = record(object["last_payment_error"]);
      return {
        kind: "payment_failed",
        eventId,
        paymentIntentId,
        failureCode: str(lastError?.["code"]),
        failureMessage: str(lastError?.["message"]),
      };
    }
    case "charge.refunded": {
      const chargeId = str(object["id"]);
      if (chargeId === undefined) return ignored;
      return {
        kind: "charge_refunded",
        eventId,
        chargeId,
        paymentIntentId: str(object["payment_intent"]),
        amountRefunded: num(object["amount_refunded"]),
        refunded: bool(object["refunded"]),
      };
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = str(object["id"]);
      if (subscriptionId === undefined) return ignored;
      return {
        kind: "subscription_updated",
        eventId,
        subscriptionId,
        status: str(object["status"]),
        customerId: str(object["customer"]),
        currentPeriodEnd: num(object["current_period_end"]),
        // A deletion is the definitive cancellation signal regardless of the
        // object's reported status.
        deleted: rawType === "customer.subscription.deleted" ? true : undefined,
      };
    }
    case "invoice.payment_failed": {
      const invoiceId = str(object["id"]);
      if (invoiceId === undefined) return ignored;
      return {
        kind: "invoice_payment_failed",
        eventId,
        invoiceId,
        subscriptionId: str(object["subscription"]),
        customerId: str(object["customer"]),
        attemptCount: num(object["attempt_count"]),
      };
    }
    case "invoice.payment_succeeded": {
      const invoiceId = str(object["id"]);
      if (invoiceId === undefined) return ignored;
      return {
        kind: "invoice_payment_succeeded",
        eventId,
        invoiceId,
        subscriptionId: str(object["subscription"]),
        customerId: str(object["customer"]),
      };
    }
    default:
      return ignored;
  }
}
