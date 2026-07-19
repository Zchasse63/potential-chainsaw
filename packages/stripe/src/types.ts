/**
 * Shared primitives for @kelo/stripe: the injectable fetch/id types, the form
 * encoder, the intended-call shape the outbox records, and the minimal typed
 * result. Kept DB-free and clock-free (id generation is injected; the workflow
 * harness forbids Math.random / Date.now in id paths).
 */

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type Env = Record<string, string | undefined>;

/**
 * Injectable id factory for the DRY-RUN synthetic-object ids. Defaults to
 * crypto.randomUUID (never Math.random). MockStripe injects a deterministic
 * counter so later units' tests get stable ids.
 */
export type IdFactory = () => string;

/** The Stripe object kinds this adapter creates in Phase 5. */
export type StripeObjectKind =
  | "payment_intent"
  | "refund"
  | "customer"
  | "subscription"
  | "price";

/**
 * Stripe's real object-id prefixes, reused to shape the dry-run ids as
 * `dry_<prefix>_<uuid>` so a dry-run id is self-describing and never mistaken
 * for a live object.
 */
export const STRIPE_ID_PREFIX: Record<StripeObjectKind, string> = {
  payment_intent: "pi",
  refund: "re",
  customer: "cus",
  subscription: "sub",
  price: "price",
};

/** Max chars of a response body kept on an error — context, never the payload. */
export const BODY_SNIPPET_MAX = 200;

/**
 * The minimal typed result of a create call.
 *
 * NOTE (pinned-sample discipline, mirroring the Glofox rule): no Stripe Connect
 * account exists yet (BLOCKERS P0-5), so the real HTTP response shapes are NOT
 * yet verified. We deliberately surface only `id` and `status` — the two fields
 * the billing pipeline needs and that are stable across every Stripe object —
 * and DO NOT invent unverified fields. When the account exists, pin a sample
 * per object and widen this type against it.
 */
export interface StripeObjectResult {
  readonly id: string;
  /**
   * Lifecycle status where the object carries one (payment_intent, refund,
   * subscription). Absent for objects without a status (customer, price) and
   * on the dry-run path (no network → nothing to report).
   */
  readonly status?: string;
  /** True only on the dry-run path; never present on a live object. */
  readonly dryRun?: boolean;
}

/** Request params, pre-encoding. Values may nest (Stripe bracket convention). */
export type StripeParams = Record<string, unknown>;

/**
 * An intended Stripe mutation, captured BEFORE the dry-run/live branch. This is
 * what the durable `stripe_commands` outbox persists (with its idempotency key)
 * and what MockStripe records so later units can assert the pipeline's intent.
 */
export interface StripeCall {
  readonly kind: StripeObjectKind;
  /** POST resource path, e.g. "/v1/payment_intents". */
  readonly path: string;
  readonly params: StripeParams;
  /** The idempotency key the outbox owns for this mutation. */
  readonly idempotencyKey: string;
}

/** A non-2xx response from a live Stripe call. */
export class StripeApiError extends Error {
  readonly status: number;
  /** The connected account the call was scoped to (id only, never a key). */
  readonly stripeAccountId: string;
  /** The resource path, e.g. "/v1/refunds". */
  readonly resource: string;
  /** First ≤200 chars of the response body — context, never a secret. */
  readonly bodySnippet: string;

  constructor(status: number, stripeAccountId: string, resource: string, bodySnippet: string) {
    super(`Stripe HTTP ${status} on ${resource} (account ${stripeAccountId}): ${bodySnippet}`);
    this.name = "StripeApiError";
    this.status = status;
    this.stripeAccountId = stripeAccountId;
    this.resource = resource;
    this.bodySnippet = bodySnippet;
  }
}

export async function stripeApiError(
  response: Response,
  stripeAccountId: string,
  resource: string,
): Promise<StripeApiError> {
  const body = (await response.text()).slice(0, BODY_SNIPPET_MAX);
  return new StripeApiError(
    response.status,
    stripeAccountId,
    resource,
    body || response.statusText,
  );
}

/**
 * Encode params as `application/x-www-form-urlencoded` with Stripe's bracket
 * convention for nested objects and arrays (e.g. `items[0][price]=price_x`,
 * `recurring[interval]=month`). `undefined`/`null` values are dropped.
 */
export function encodeStripeForm(params: StripeParams): string {
  const search = new URLSearchParams();
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${key}]`, nested);
      }
      return;
    }
    search.append(prefix, String(value));
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return search.toString();
}
