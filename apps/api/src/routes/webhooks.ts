import type { Hono } from "hono";
import {
  mapResendEvent,
  mapTwilioEvent,
  verifyResendSignature,
  verifyTwilioSignature,
  toE164US,
  type ProviderAction,
  type SuppressionReason,
  type TwilioParams,
} from "@kelo/comms";
import { verifyStripeSignature } from "@kelo/stripe";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import type { AppEnv } from "../types.js";

interface QueryError {
  message: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface ServiceBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): ServiceBuilder;
  insert(values: unknown): ServiceBuilder;
  upsert(
    values: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): ServiceBuilder;
  update(values: unknown): ServiceBuilder;
  eq(column: string, value: unknown): ServiceBuilder;
  in(column: string, values: readonly unknown[]): ServiceBuilder;
  limit(count: number): ServiceBuilder;
}

export interface WebhookDeps {
  createWebhookClient?: () => KeloSupabaseClient;
  webhookEnv?: Record<string, string | undefined>;
  webhookNow?: () => Date;
}

interface LogReference {
  id: string;
  tenant_id: string;
  person_id: string | null;
  channel: "email" | "sms";
  to_address: string;
  status: string;
}

interface PersonReference {
  id: string;
  tenant_id: string;
}

function from(client: KeloSupabaseClient, table: string): ServiceBuilder {
  return client.from(table) as unknown as ServiceBuilder;
}

async function run(builder: ServiceBuilder, label: string): Promise<unknown> {
  const { data, error } = await builder;
  if (error !== null) throw new Error(`${label} failed: ${error.message}`);
  return data;
}

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function eventIdForTwilio(params: Record<string, string>): string | null {
  const sid = params["MessageSid"] ?? params["SmsSid"];
  if (sid === undefined || sid === "") return null;
  const transition = params["OptOutType"] ?? params["MessageStatus"] ?? params["SmsStatus"];
  return transition === undefined || transition === "" ? sid : `${sid}:${transition.toUpperCase()}`;
}

function twilioParams(rawBody: string): {
  signatureParams: TwilioParams;
  payload: Record<string, string>;
} {
  const parsed = new URLSearchParams(rawBody);
  const signatureParams: TwilioParams = {};
  const payload: Record<string, string> = {};
  for (const key of new Set(parsed.keys())) {
    const values = parsed.getAll(key);
    signatureParams[key] = values.length === 1 ? values[0]! : values;
    payload[key] = values.at(-1) ?? "";
  }
  return { signatureParams, payload };
}

async function insertInbox(
  client: KeloSupabaseClient,
  provider: "resend" | "twilio",
  eventId: string,
  payload: unknown,
): Promise<boolean> {
  const data = await run(
    from(client, "webhook_events")
      .upsert(
        { provider, event_id: eventId, payload, status: "received" },
        { onConflict: "provider,event_id", ignoreDuplicates: true },
      )
      .select("id")
      .limit(1),
    "webhook inbox insert",
  );
  if (rows<{ id: string }>(data).length > 0) return true;

  // A processed/received duplicate is a no-op. An earlier inline processing
  // error may be retried by a provider redelivery while preserving the same
  // inbox row and event id.
  const existing = await run(
    from(client, "webhook_events")
      .select("status")
      .eq("provider", provider)
      .eq("event_id", eventId)
      .limit(1),
    "webhook inbox duplicate lookup",
  );
  return rows<{ status: string }>(existing)[0]?.status === "error";
}

async function finishInbox(
  client: KeloSupabaseClient,
  provider: "resend" | "twilio",
  eventId: string,
  status: "processed" | "error",
  now: Date,
  error: string | null,
): Promise<void> {
  await run(
    from(client, "webhook_events")
      .update({ status, processed_at: now.toISOString(), error })
      .eq("provider", provider)
      .eq("event_id", eventId),
    "webhook inbox finalize",
  );
}

async function insertSuppression(
  client: KeloSupabaseClient,
  row: LogReference,
  reason: SuppressionReason,
  address: string,
): Promise<void> {
  await run(
    from(client, "comms_suppressions").upsert(
      {
        tenant_id: row.tenant_id,
        person_id: row.person_id,
        channel: row.channel,
        address: row.channel === "email" ? address.toLowerCase() : address,
        reason,
      },
      { onConflict: "tenant_id,channel,address", ignoreDuplicates: true },
    ),
    "provider suppression insert",
  );
}

async function processStatus(
  client: KeloSupabaseClient,
  action: Extract<ProviderAction, { kind: "status" }>,
): Promise<void> {
  const data = await run(
    from(client, "comms_log")
      .select("id, tenant_id, person_id, channel, to_address, status")
      .eq("provider_message_id", action.providerMessageId)
      .limit(1),
    "provider message lookup",
  );
  const row = rows<LogReference>(data)[0];
  if (row === undefined) {
    throw new Error(`no comms_log row for provider message ${action.providerMessageId}`);
  }

  const allowedPriorStatuses: Record<typeof action.status, readonly string[]> = {
    sent: ["queued", "sent"],
    delivered: ["queued", "sent"],
    bounced: ["queued", "sent", "delivered"],
    failed: ["queued", "sent"],
    suppressed: ["queued", "sent", "delivered"],
  };

  // Resolve tenant through the message first, then scope every service-role
  // mutation explicitly by both row id and resolved tenant id. The prior-state
  // predicate also prevents an out-of-order `sent` callback from regressing a
  // row that is already delivered/bounced/failed.
  if (action.suppressionReason !== undefined) {
    await insertSuppression(
      client,
      row,
      action.suppressionReason,
      action.suppressionAddress ?? row.to_address,
    );
  }
  await run(
    from(client, "comms_log")
      .update({ status: action.status, status_detail: action.detail ?? null })
      .eq("id", row.id)
      .eq("tenant_id", row.tenant_id)
      .in("status", allowedPriorStatuses[action.status]),
    "provider status update",
  );
}

async function processStop(
  client: KeloSupabaseClient,
  action: Extract<ProviderAction, { kind: "stop" }>,
): Promise<string | null> {
  const canonicalFrom = toE164US(action.from);
  const people =
    canonicalFrom === null
      ? []
      : rows<PersonReference>(
          await run(
            from(client, "people").select("id, tenant_id").eq("phone_e164", canonicalFrom),
            "STOP person lookup",
          ),
        );

  if (people.length === 0) {
    // One global Twilio number cannot identify a tenant when no person matches.
    // Per-tenant numbers are the long-term fix. Never silently lose an opt-out:
    // surface the unresolved event for review; whenever tenancy is knowable,
    // fail OPEN (over-suppress) rather than closed.
    console.warn(
      "[kelo] unresolved Twilio STOP: no person matched the canonical sender; per-tenant numbers are required for tenant attribution",
    );
    return "stop_unresolved_no_person";
  }

  const peopleByTenant = new Map<string, PersonReference[]>();
  for (const person of people) {
    const tenantPeople = peopleByTenant.get(person.tenant_id) ?? [];
    tenantPeople.push(person);
    peopleByTenant.set(person.tenant_id, tenantPeople);
  }

  const tenantMatches = [...peopleByTenant.entries()].map(([tenantId, tenantPeople]) => ({
    tenantId,
    people: tenantPeople,
    personId: tenantPeople.length === 1 ? tenantPeople[0]!.id : null,
  }));

  await run(
    from(client, "comms_suppressions").upsert(
      tenantMatches.map((match) => ({
        tenant_id: match.tenantId,
        person_id: match.personId,
        channel: "sms",
        address: canonicalFrom,
        reason: "stop_reply",
      })),
      { onConflict: "tenant_id,channel,address", ignoreDuplicates: true },
    ),
    "STOP suppression insert",
  );

  // Consent evidence is person-scoped and person_id is NOT NULL, so an
  // ambiguous tenant gets one revocation per matching person while its
  // address suppression and inbound log deliberately remain unattributed.
  await run(
    from(client, "communication_consents").insert(
      tenantMatches.flatMap((match) =>
        match.people.map((person) => ({
          tenant_id: match.tenantId,
          person_id: person.id,
          channel: "sms",
          status: "revoked",
          evidence: {
            source: "stop_reply",
            details: { provider: "twilio", provider_message_id: action.providerMessageId },
          },
        })),
      ),
    ),
    "STOP consent evidence insert",
  );
  await run(
    from(client, "comms_log").insert(
      tenantMatches.map((match) => ({
        tenant_id: match.tenantId,
        person_id: match.personId,
        channel: "sms",
        direction: "inbound",
        body_preview: action.body.slice(0, 200),
        to_address: canonicalFrom,
        provider: "twilio",
        provider_message_id: action.providerMessageId,
        status: "delivered",
        status_detail: "inbound STOP",
      })),
    ),
    "STOP inbound comms log insert",
  );

  return null;
}

async function processAction(
  client: KeloSupabaseClient,
  action: ProviderAction,
): Promise<string | null> {
  if (action.kind === "status") await processStatus(client, action);
  if (action.kind === "stop") return processStop(client, action);
  return null;
}

async function processPersisted(
  client: KeloSupabaseClient,
  provider: "resend" | "twilio",
  eventId: string,
  action: ProviderAction,
  now: Date,
): Promise<void> {
  try {
    const detail = await processAction(client, action);
    await finishInbox(client, provider, eventId, "processed", now, detail);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : "unknown webhook error").slice(
      0,
      1_000,
    );
    // v1 processes immediately after the durable insert. Processing errors are
    // retained in the inbox and still ACKed; moving this exact step to a queue
    // processor is the scale-later 200-fast/process-async shape.
    await finishInbox(client, provider, eventId, "error", now, detail);
  }
}

// --- Stripe (billing spine, Phase 5) -------------------------------------------
// The receiver's ONLY job is to durably record the signature-verified event in
// the stripe_events inbox (threat-model §6). It NEVER processes inline: the
// 'stripe.process_inbox' worker consumes the TABLE, and the signed webhook — not
// the HTTP request — is the confirmation authority that flips a payment's money
// state. Deliberately kept to one INSERT so the 200 is fast and crash-safe.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The inbox columns a Stripe event carries: its id, type, and (Connect) the
 * connected account it was scoped to. Tenancy resolves later, in the processor,
 * through stripe_account_id — the inbox has no tenant_id (migration 0033). */
function stripeEventFields(payload: unknown): {
  eventId: string | null;
  type: string | null;
  stripeAccountId: string | null;
} {
  const envelope = asRecord(payload);
  return {
    eventId: asStr(envelope?.["id"]),
    type: asStr(envelope?.["type"]),
    stripeAccountId: asStr(envelope?.["account"]),
  };
}

async function insertStripeEvent(
  client: KeloSupabaseClient,
  fields: { eventId: string; type: string | null; stripeAccountId: string | null },
  payload: unknown,
): Promise<void> {
  // on conflict(event_id) do nothing — Stripe delivers at least once, so a
  // redelivery of an already-recorded event is a durable no-op (unique(event_id),
  // migration 0033). ignoreDuplicates makes the upsert a pure insert-or-skip.
  await run(
    from(client, "stripe_events").upsert(
      {
        event_id: fields.eventId,
        type: fields.type,
        stripe_account_id: fields.stripeAccountId,
        payload,
        status: "received",
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    ),
    "stripe inbox insert",
  );
}

/** Public routes: no auth middleware. The provider signature is the auth. */
export function registerWebhookRoutes(app: Hono<AppEnv>, deps: WebhookDeps = {}): void {
  const env = () => deps.webhookEnv ?? process.env;
  const client = () => deps.createWebhookClient?.() ?? createServiceRoleClient();
  const now = () => deps.webhookNow?.() ?? new Date();

  app.post("/webhooks/resend", async (c) => {
    // Hono's c.req.text() reads the untouched request bytes as text. Verify
    // this raw string before JSON.parse; reserialization breaks Svix HMACs.
    const rawBody = await c.req.text();
    const secret = env()["RESEND_WEBHOOK_SECRET"];
    if (secret === undefined || secret === "") return c.text("webhook not configured", 503);
    if (!(await verifyResendSignature(rawBody, c.req.raw.headers, secret))) {
      return c.text("invalid signature", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return c.text("invalid payload", 400);
    }
    const eventId = c.req.header("svix-id");
    if (eventId === undefined || eventId === "") return c.text("missing event id", 400);
    const service = client();
    if (await insertInbox(service, "resend", eventId, payload)) {
      await processPersisted(service, "resend", eventId, mapResendEvent(payload), now());
    }
    return c.json({ received: true });
  });

  app.post("/webhooks/twilio", async (c) => {
    // Twilio signs the exact public URL plus every form field. Read raw first,
    // then preserve all URLSearchParams values for the documented sorted-field
    // HMAC-SHA1 calculation before applying any business logic.
    const rawBody = await c.req.text();
    const parsed = twilioParams(rawBody);
    // TWILIO_WEBHOOK_AUTH may hold the same primary Auth Token in a
    // webhook-only secret binding; fall back to the adapter's AUTH_TOKEN.
    const token = env()["TWILIO_WEBHOOK_AUTH"] ?? env()["TWILIO_AUTH_TOKEN"];
    if (token === undefined || token === "") return c.text("webhook not configured", 503);
    if (
      !(await verifyTwilioSignature(c.req.url, parsed.signatureParams, c.req.raw.headers, token))
    ) {
      return c.text("invalid signature", 401);
    }

    const eventId = eventIdForTwilio(parsed.payload);
    if (eventId === null) return c.text("missing event id", 400);
    const service = client();
    if (await insertInbox(service, "twilio", eventId, parsed.payload)) {
      await processPersisted(service, "twilio", eventId, mapTwilioEvent(parsed.payload), now());
    }
    return c.json({ received: true });
  });

  app.post("/webhooks/stripe", async (c) => {
    // Stripe signs `${t}.${rawBody}`; read the untouched bytes BEFORE any parse
    // (reserialization would break the HMAC). The signature IS the auth here.
    const rawBody = await c.req.text();
    const secret = env()["STRIPE_WEBHOOK_SECRET"];
    if (secret === undefined || secret === "") return c.text("webhook not configured", 503);
    const signature = c.req.header("stripe-signature") ?? "";
    // Inject the clock so staleness (replay beyond the 300s tolerance) is
    // deterministically testable and matches the rest of the webhook surface.
    const valid = await verifyStripeSignature(rawBody, signature, secret, {
      nowSeconds: Math.floor(now().getTime() / 1000),
    });
    // Invalid OR stale → 401 with NO DB write. A forged/replayed event must
    // never reach the inbox (threat-model §6: money, webhook forgery/replay).
    if (!valid) return c.text("invalid signature", 401);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return c.text("invalid payload", 400);
    }
    const fields = stripeEventFields(payload);
    if (fields.eventId === null) return c.text("missing event id", 400);

    // Durably record ONLY, then 200 FAST. Processing happens off the request in
    // the 'stripe.process_inbox' worker, which consumes this table.
    await insertStripeEvent(
      client(),
      { eventId: fields.eventId, type: fields.type, stripeAccountId: fields.stripeAccountId },
      payload,
    );
    return c.json({ received: true });
  });
}
