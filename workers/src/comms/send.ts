import {
  ResendAdapter,
  TwilioAdapter,
  canSend,
  resendConfigFromEnv,
  twilioConfigFromEnv,
  type ConsentStatus,
  type Env,
  type FetchImpl,
  type MessageAdapter,
  type MessageKind,
  type SuppressionReason,
} from "@kelo/comms";
import type { JobProcessor, JobRow, Queryable } from "../processors.js";

export const COMMS_SEND_KIND = "comms.send";

interface SendRow {
  id: string;
  tenant_id: string;
  person_id: string | null;
  channel: "email" | "sms";
  status: string;
  template_key: string | null;
  subject: string | null;
  body_preview: string | null;
  to_address: string;
  campaign_key: string | null;
  person_source: string | null;
  consent_status: ConsentStatus | null;
  suppression_reason: SuppressionReason | null;
  tenant_settings: Record<string, unknown> | null;
  timezone: string;
}

export interface CommsSendDeps {
  emailAdapter?: MessageAdapter;
  smsAdapter?: MessageAdapter;
  fetchImpl?: FetchImpl;
  env?: Env;
  now?: () => Date;
}

function requireTenant(job: JobRow): string {
  if (job.tenant_id === null) throw new Error("comms.send requires a tenant-scoped job row");
  return job.tenant_id;
}

function requireLogId(job: JobRow): string {
  const keys = Object.keys(job.payload);
  const id = job.payload["comms_log_id"];
  if (keys.length !== 1 || keys[0] !== "comms_log_id" || typeof id !== "string" || id === "") {
    throw new Error("comms.send payload must contain only { comms_log_id }");
  }
  return id;
}

/** The migration has no kind column: campaign rows are marketing; dunning
 * templates opt into transactional_quiet; all other operational rows are
 * ordinary transactional. This keeps the queue payload ID-only. */
export function classifyMessageKind(
  row: Pick<SendRow, "campaign_key" | "template_key">,
): MessageKind {
  if (row.campaign_key !== null) return "marketing";
  if (row.template_key?.toLowerCase().startsWith("dunning") === true) {
    return "transactional_quiet";
  }
  return "transactional";
}

function quietSetting(settings: Record<string, unknown> | null, key: "start" | "end"): string {
  const fallback = key === "start" ? "21:00" : "09:00";
  if (settings === null) return fallback;
  const direct = settings[`quiet_${key}`];
  if (typeof direct === "string") return direct;
  const quietHours = settings["quiet_hours"];
  if (typeof quietHours === "object" && quietHours !== null) {
    const nested = (quietHours as Record<string, unknown>)[key];
    if (typeof nested === "string") return nested;
  }
  return fallback;
}

async function loadSendRow(
  pool: Queryable,
  tenantId: string,
  logId: string,
): Promise<SendRow | null> {
  const result = await pool.query(
    `select
       cl.id,
       cl.tenant_id,
       cl.person_id,
       cl.channel,
       cl.status,
       cl.template_key,
       cl.subject,
       cl.body_preview,
       cl.to_address,
       cl.campaign_key,
       p.source as person_source,
       consent.status as consent_status,
       suppression.reason as suppression_reason,
       t.settings as tenant_settings,
       coalesce((
         select l.timezone
         from public.locations l
         where l.tenant_id = cl.tenant_id
         order by l.created_at, l.id
         limit 1
       ), 'UTC') as timezone
     from public.comms_log cl
     join public.tenants t on t.id = cl.tenant_id
     left join public.people p
       on p.id = cl.person_id
      and p.tenant_id = cl.tenant_id
     left join lateral (
       select cc.status
       from public.communication_consents cc
       where cc.tenant_id = cl.tenant_id
         and cc.person_id = cl.person_id
         and cc.channel = cl.channel
       order by cc.occurred_at desc, cc.created_at desc, cc.id desc
       limit 1
     ) consent on true
     left join lateral (
       select cs.reason
       from public.comms_suppressions cs
       where cs.tenant_id = cl.tenant_id
         and cs.channel = cl.channel
         and case
           when cl.channel = 'email' then lower(cs.address) = lower(cl.to_address)
           else cs.address = cl.to_address
         end
       order by cs.created_at desc, cs.id desc
       limit 1
     ) suppression on true
     where cl.id = $1
       and cl.tenant_id = $2
     limit 1`,
    [logId, tenantId],
  );
  return (result.rows[0] as SendRow | undefined) ?? null;
}

async function updateStatus(
  pool: Queryable,
  row: SendRow,
  status: string,
  detail: string | null,
  provider: string | null = null,
  providerMessageId: string | null = null,
): Promise<void> {
  await pool.query(
    `update public.comms_log
     set status = $1,
         status_detail = $2,
         provider = coalesce($3, provider),
         provider_message_id = coalesce($4, provider_message_id)
     where id = $5
       and tenant_id = $6
       and status = 'queued'`,
    [status, detail, provider, providerMessageId, row.id, row.tenant_id],
  );
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown provider error").slice(0, 1_000);
}

export function createCommsSendProcessor(deps: CommsSendDeps = {}): JobProcessor {
  return async (job, ctx) => {
    const tenantId = requireTenant(job);
    const logId = requireLogId(job);
    const row = await loadSendRow(ctx.pool, tenantId, logId);
    if (row === null) throw new Error(`comms_log ${logId} not found for tenant ${tenantId}`);

    // Queue retries/reclaims are idempotent at the message row: once a prior
    // attempt changed queued to any terminal/provider status, do nothing.
    if (row.status !== "queued") return;

    const settings = row.tenant_settings;
    const importedOptIn = settings?.["imported_consent_optin"] === true;
    const policy = canSend({
      channel: row.channel,
      person: {
        consents: { [row.channel]: row.consent_status },
        imported: row.person_source === "glofox",
      },
      suppressed: row.suppression_reason !== null,
      suppressionReason: row.suppression_reason ?? undefined,
      kind: classifyMessageKind(row),
      now: deps.now?.() ?? new Date(),
      timezone: row.timezone,
      quietStart: quietSetting(settings, "start"),
      quietEnd: quietSetting(settings, "end"),
      importedConsentOptIn: importedOptIn,
    });

    if (!policy.allowed) {
      const status = {
        suppressed: "suppressed",
        no_consent: "skipped_no_consent",
        quiet_hours: "skipped_quiet_hours",
      }[policy.reason];
      await updateStatus(ctx.pool, row, status, policy.reason);
      return;
    }

    const env = deps.env ?? process.env;
    const adapter =
      row.channel === "email"
        ? (deps.emailAdapter ??
          new ResendAdapter({ ...resendConfigFromEnv(env), fetchImpl: deps.fetchImpl }))
        : (deps.smsAdapter ??
          new TwilioAdapter({ ...twilioConfigFromEnv(env), fetchImpl: deps.fetchImpl }));

    try {
      // body_preview is the complete v1 send body (capped at 200 by migration
      // 0022). Full retained bodies/templates arrive with the retention unit.
      const result = await adapter.send({
        to: row.to_address,
        subject: row.subject ?? undefined,
        body: row.body_preview ?? "",
      });
      await updateStatus(
        ctx.pool,
        row,
        result.dryRun === true ? "dry_run" : "sent",
        null,
        result.dryRun === true ? "dry_run" : row.channel === "email" ? "resend" : "twilio",
        result.providerMessageId,
      );
    } catch (error) {
      await updateStatus(ctx.pool, row, "failed", errorDetail(error));
    }
  };
}

export function commsSendProcessorForTest(
  deps: CommsSendDeps,
): (job: JobRow, pool: Queryable) => Promise<void> {
  const processor = createCommsSendProcessor(deps);
  return (job, pool) => processor(job, { pool, workerId: "comms-test" });
}
