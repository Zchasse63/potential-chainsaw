import {
  encodeStripeForm,
  stripeApiError,
  STRIPE_ID_PREFIX,
  type Env,
  type FetchImpl,
  type IdFactory,
  type StripeCall,
  type StripeObjectKind,
  type StripeObjectResult,
  type StripeParams,
} from "./types.js";

/**
 * The ONE Stripe adapter (Phase 5 billing spine; CLAUDE.md invariant #5,
 * threat-model §6). Mirrors the @kelo/comms injectable-adapter + dry-run
 * discipline exactly:
 *
 *   - Constructed PER CONNECTED ACCOUNT (`stripeAccountId` + the platform
 *     secret key from env `STRIPE_SECRET_KEY`). Per-connected-account scoping
 *     from the first line — the `Stripe-Account` header rides EVERY call.
 *   - The caller passes the `Idempotency-Key` (the durable `stripe_commands`
 *     outbox owns the key; the adapter never mints one). Every mutation
 *     requires a non-empty key — refuses without one.
 *   - When `STRIPE_SECRET_KEY` is ABSENT (or `dryRun` is forced) → DRY-RUN:
 *     returns a synthetic `{ id: 'dry_<prefix>_<uuid>', dryRun: true }` and
 *     makes NO network call, so the whole billing pipeline is exercisable
 *     before the real Connect account exists (BLOCKERS P0-5).
 *
 * DB-free and clock-free. HTTP is injectable; tests never touch the network.
 */
export interface StripeConfig {
  /**
   * The connected account this client speaks for — the `Stripe-Account` header
   * on every call. REQUIRED: there is no un-scoped platform mode here.
   */
  readonly stripeAccountId: string;
  /** Platform secret key (env `STRIPE_SECRET_KEY`). ABSENT/"" → dry-run. */
  readonly secretKey?: string;
  /** Force dry-run even when a key is present (staging / MockStripe). */
  readonly dryRun?: boolean;
  /** Injectable HTTP impl. Tests stub this; tests never hit the network. */
  readonly fetchImpl?: FetchImpl;
  /**
   * Injectable id factory for the dry-run synthetic ids. Default
   * `crypto.randomUUID` (never Math.random). MockStripe injects a counter.
   */
  readonly newId?: IdFactory;
  /** Stripe API base. Default `https://api.stripe.com`. */
  readonly baseUrl?: string;
  /**
   * Optional observer invoked with every intended call BEFORE the
   * dry-run/live branch — lets MockStripe record what the pipeline requested.
   */
  readonly recorder?: (call: StripeCall) => void;
}

/** Reads `STRIPE_SECRET_KEY` BY NAME for one connected account. Value never logged. */
export function stripeConfigFromEnv(
  stripeAccountId: string,
  env: Env = process.env,
): StripeConfig {
  return { stripeAccountId, secretKey: env["STRIPE_SECRET_KEY"] };
}

export interface CreatePaymentIntentParams {
  /** Amount in the smallest currency unit (e.g. cents). */
  readonly amount: number;
  readonly currency: string;
  readonly customer?: string;
  /** Outbox-owned idempotency key. */
  readonly idempotencyKey: string;
}

export interface CreateRefundParams {
  readonly paymentIntent: string;
  /** Amount in the smallest currency unit; omit for a full refund. */
  readonly amount?: number;
  readonly idempotencyKey: string;
}

export interface CreateCustomerParams {
  readonly email?: string;
  readonly name?: string;
  readonly idempotencyKey: string;
}

export interface SubscriptionItemParam {
  readonly price: string;
  readonly quantity?: number;
}

export interface CreateSubscriptionParams {
  readonly customer: string;
  readonly items: readonly SubscriptionItemParam[];
  readonly idempotencyKey: string;
}

export interface PriceRecurringParam {
  readonly interval: "day" | "week" | "month" | "year";
  readonly intervalCount?: number;
}

export interface CreatePriceParams {
  readonly currency: string;
  /** Amount in the smallest currency unit. */
  readonly unitAmount: number;
  readonly product?: string;
  /** Omit for a one-off price; present for a subscription price. */
  readonly recurring?: PriceRecurringParam;
  readonly idempotencyKey: string;
}

const DEFAULT_BASE_URL = "https://api.stripe.com";

export class StripeClient {
  readonly #config: StripeConfig;
  readonly #newId: IdFactory;
  readonly #dryRun: boolean;

  constructor(config: StripeConfig) {
    if (config.stripeAccountId === "") {
      throw new Error("StripeClient requires a connected stripeAccountId (per-account scoping).");
    }
    this.#config = config;
    this.#newId = config.newId ?? (() => crypto.randomUUID());
    this.#dryRun =
      config.dryRun === true || config.secretKey === undefined || config.secretKey === "";
  }

  /** True when this client makes NO network call (no key, or forced). */
  get isDryRun(): boolean {
    return this.#dryRun;
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<StripeObjectResult> {
    return this.#dispatch("payment_intent", "/v1/payment_intents", params.idempotencyKey, {
      amount: params.amount,
      currency: params.currency,
      customer: params.customer,
    });
  }

  async createRefund(params: CreateRefundParams): Promise<StripeObjectResult> {
    return this.#dispatch("refund", "/v1/refunds", params.idempotencyKey, {
      payment_intent: params.paymentIntent,
      amount: params.amount,
    });
  }

  async createCustomer(params: CreateCustomerParams): Promise<StripeObjectResult> {
    return this.#dispatch("customer", "/v1/customers", params.idempotencyKey, {
      email: params.email,
      name: params.name,
    });
  }

  async createSubscription(params: CreateSubscriptionParams): Promise<StripeObjectResult> {
    return this.#dispatch("subscription", "/v1/subscriptions", params.idempotencyKey, {
      customer: params.customer,
      items: params.items.map((item) => ({ price: item.price, quantity: item.quantity })),
    });
  }

  async createPrice(params: CreatePriceParams): Promise<StripeObjectResult> {
    return this.#dispatch("price", "/v1/prices", params.idempotencyKey, {
      currency: params.currency,
      unit_amount: params.unitAmount,
      product: params.product,
      recurring:
        params.recurring === undefined
          ? undefined
          : {
              interval: params.recurring.interval,
              interval_count: params.recurring.intervalCount,
            },
    });
  }

  async #dispatch(
    kind: StripeObjectKind,
    path: string,
    idempotencyKey: string,
    params: StripeParams,
  ): Promise<StripeObjectResult> {
    if (idempotencyKey === "") {
      throw new Error(
        `Stripe ${kind} requires an Idempotency-Key (the outbox owns it) — refusing to call without one.`,
      );
    }
    this.#config.recorder?.({ kind, path, params, idempotencyKey });

    if (this.#dryRun) {
      return { id: `dry_${STRIPE_ID_PREFIX[kind]}_${this.#newId()}`, dryRun: true };
    }

    const secretKey = this.#config.secretKey as string;
    const baseUrl = this.#config.baseUrl ?? DEFAULT_BASE_URL;
    const fetchImpl = this.#config.fetchImpl ?? fetch;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // Connect scoping — the connected account, on EVERY call (threat-model §6).
        "stripe-account": this.#config.stripeAccountId,
        // The outbox-owned idempotency key — Stripe dedupes retries by this.
        "idempotency-key": idempotencyKey,
      },
      body: encodeStripeForm(params),
    });
    if (!response.ok) {
      throw await stripeApiError(response, this.#config.stripeAccountId, path);
    }
    const payload = (await response.json()) as { id?: unknown; status?: unknown };
    if (typeof payload.id !== "string" || payload.id === "") {
      throw new Error(`Stripe ${kind} response did not include an id`);
    }
    return {
      id: payload.id,
      ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    };
  }
}
