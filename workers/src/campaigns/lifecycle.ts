import type { JobProcessor, JobRow, Queryable } from "../processors.js";
import { buildCampaignPlan } from "./enqueuer.js";
import { draftCampaignCopy, type DraftOptions } from "./draft.js";

export const CAMPAIGNS_LIFECYCLE_KIND = "campaigns.lifecycle";
export const DEFAULT_MARKETING_COOLDOWN_DAYS = 7;

interface AutomationRow {
  template_key: string;
  segment_key: string;
  channel: "email" | "sms";
  kind: "marketing" | "transactional" | "transactional_quiet";
  subject: string | null;
  body: string;
}

function tenantOf(job: JobRow): string {
  if (job.tenant_id === null) throw new Error("campaigns.lifecycle requires a tenant-scoped job");
  return job.tenant_id;
}

function studioDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`could not resolve studio day for timezone ${timezone}`);
  }
  return `${year}-${month}-${day}`;
}

/**
 * Daily catalog evaluator. It creates proposals, materializes previews, and
 * removes recipients still inside the shared marketing cooldown. It never
 * invokes app.approve_campaign and never inserts comms_log/jobs.
 */
export async function evaluateLifecycle(
  pool: Queryable,
  tenantId: string,
  options: { now?: Date; cooldownDays?: number; draft?: DraftOptions } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const cooldownDays = options.cooldownDays ?? DEFAULT_MARKETING_COOLDOWN_DAYS;
  const catalog = await pool.query(
    `select distinct on (coalesce(mt.tenant_id, $1::uuid), mt.segment_key, mt.channel)
       mt.key as template_key, mt.segment_key, mt.channel, mt.kind, mt.subject, mt.body
     from public.message_templates mt
     where (mt.tenant_id is null or mt.tenant_id = $1)
       and mt.segment_key is not null
     order by coalesce(mt.tenant_id, $1::uuid), mt.segment_key, mt.channel,
              (mt.tenant_id is not null) desc, mt.version desc`,
    [tenantId],
  );
  const tenantResult = await pool.query(
    `select t.name, t.settings, coalesce((
       select l.timezone from public.locations l
       where l.tenant_id = t.id order by l.created_at, l.id limit 1
     ), 'UTC') as timezone
     from public.tenants t where t.id = $1 limit 1`,
    [tenantId],
  );
  const tenant = (tenantResult.rows[0] as
    | { name?: unknown; settings?: Record<string, unknown> | null; timezone?: unknown }
    | undefined) ?? { name: "the studio", settings: null };
  const studioName = typeof tenant.name === "string" ? tenant.name : "the studio";
  const timezone = typeof tenant.timezone === "string" ? tenant.timezone : "UTC";
  const day = studioDay(now, timezone);
  const settings = tenant.settings ?? {};

  const created: string[] = [];
  for (const automation of catalog.rows as AutomationRow[]) {
    const countResult = await pool.query(
      `select count(*)::int as recipient_count
       from public.segment_current($1) where segment_key = $2`,
      [tenantId, automation.segment_key],
    );
    const countValue = (countResult.rows[0] as { recipient_count?: unknown } | undefined)
      ?.recipient_count;
    const recipientCount = typeof countValue === "number" ? countValue : 0;
    const brandVoice =
      typeof settings["brand_voice"] === "object" && settings["brand_voice"] !== null
        ? (settings["brand_voice"] as Record<string, unknown>)
        : {};
    const strings = (key: string): string[] | undefined => {
      const value = brandVoice[key];
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    };
    const string = (key: string): string | undefined => {
      const value = brandVoice[key];
      return typeof value === "string" ? value : undefined;
    };
    const copy = await draftCampaignCopy(
      {
        segmentKey: automation.segment_key,
        recipientCount,
        templateIntent: `Use the ${automation.template_key} approved template intent.`,
        brandFacts: {
          studioName,
          ...(strings("tone_adjectives") === undefined
            ? {}
            : { toneAdjectives: strings("tone_adjectives") }),
          ...(strings("say") === undefined ? {} : { say: strings("say") }),
          ...(strings("never_say") === undefined ? {} : { neverSay: strings("never_say") }),
          ...(string("sign_off") === undefined ? {} : { signOff: string("sign_off") }),
          ...(string("emoji_stance") === undefined
            ? {}
            : { emojiStance: string("emoji_stance") }),
          ...(string("discount_philosophy") === undefined
            ? {}
            : { discountPhilosophy: string("discount_philosophy") }),
        },
        channel: automation.channel,
        kind: automation.kind,
      },
      { subject: automation.subject, body: automation.body },
      options.draft,
    );
    const inserted = await pool.query(
      `insert into public.campaigns
         (tenant_id, name, segment_key, template_key, channel, kind,
          draft_subject, draft_body, draft_source, status, created_by, scheduled_for)
       select $1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', null, $10
       where not exists (
         select 1 from public.campaigns c
         where c.tenant_id = $1
           and c.segment_key = $3
           and c.template_key = $4
           and c.channel = $5
           and (c.created_at at time zone $12)::date = $11::date
           and c.status <> 'cancelled'
       )
       returning id`,
      [
        tenantId,
        `${automation.segment_key.replaceAll("_", " ")} · ${day}`,
        automation.segment_key,
        automation.template_key,
        automation.channel,
        automation.kind,
        copy.subject,
        copy.body,
        copy.source === "ai" ? "ai" : "template",
        now.toISOString(),
        day,
        timezone,
      ],
    );
    const campaignId = (inserted.rows[0] as { id?: unknown } | undefined)?.id;
    if (typeof campaignId !== "string") continue;

    await buildCampaignPlan(pool, campaignId);
    if (automation.kind === "marketing") {
      // campaign_sends has a deliberately closed policy-status vocabulary;
      // cooldown recipients are excluded from this lifecycle proposal rather
      // than mislabeled as consent/suppression failures.
      await pool.query(
        `delete from public.campaign_sends cs
         where cs.campaign_id = $1
           and exists (
             select 1 from public.comms_log cl
             where cl.tenant_id = cs.tenant_id
               and cl.person_id = cs.person_id
               and cl.direction = 'outbound'
               and cl.campaign_key is not null
               and cl.status in ('queued', 'sent', 'delivered')
               and cl.created_at >= $2::timestamptz - ($3::text || ' days')::interval
           )`,
        [campaignId, now.toISOString(), cooldownDays],
      );
    }
    created.push(campaignId);
  }
  return created;
}

export function createLifecycleProcessor(options: {
  now?: () => Date;
  draft?: DraftOptions;
} = {}): JobProcessor {
  return async (job, ctx) => {
    await evaluateLifecycle(ctx.pool, tenantOf(job), {
      now: options.now?.(),
      draft: options.draft,
    });
  };
}
