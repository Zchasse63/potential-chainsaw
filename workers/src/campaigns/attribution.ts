import type { JobProcessor, JobRow, Queryable } from "../processors.js";

export const CAMPAIGNS_ATTRIBUTE_KIND = "campaigns.attribute";
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;

function tenantOf(job: JobRow): string {
  if (job.tenant_id === null) throw new Error("campaigns.attribute requires a tenant-scoped job");
  return job.tenant_id;
}

/** Deterministic post-send correlation. ON CONFLICT makes every rerun safe. */
export async function attributeCampaigns(
  pool: Queryable,
  tenantId: string,
  windowDays = DEFAULT_ATTRIBUTION_WINDOW_DAYS,
): Promise<number> {
  const result = await pool.query(
    `with person_refs as (
       select p.tenant_id, p.id as person_id, p.external_ref
       from public.people p
       where p.tenant_id = $1 and p.external_ref is not null
       union
       select per.tenant_id, per.person_id, per.external_ref
       from public.person_external_refs per
       where per.tenant_id = $1 and per.system = 'glofox'
     ), candidate_events as (
       select cs.tenant_id, cs.id as campaign_send_id, cs.person_id,
              'booking'::text as event_type, gb.external_ref as event_ref,
              coalesce(gb.created_at, gb.time_start) as occurred_at
       from public.campaign_sends cs
       join public.comms_log cl on cl.id = cs.comms_log_id and cl.tenant_id = cs.tenant_id
       join person_refs pr on pr.person_id = cs.person_id and pr.tenant_id = cs.tenant_id
       join public.glofox_bookings gb
         on gb.tenant_id = cs.tenant_id and gb.person_external_ref = pr.external_ref
       where cs.tenant_id = $1
         and cl.status in ('sent', 'delivered')
         and coalesce(gb.created_at, gb.time_start) >= cl.updated_at
         and coalesce(gb.created_at, gb.time_start) <= cl.updated_at + ($2::text || ' days')::interval
         and gb.status in ('BOOKED', 'RESERVED')
       union all
       select cs.tenant_id, cs.id, cs.person_id,
              'purchase'::text, gt.external_ref,
              coalesce(gt.transaction_created_at, gt.created_at)
       from public.campaign_sends cs
       join public.comms_log cl on cl.id = cs.comms_log_id and cl.tenant_id = cs.tenant_id
       join person_refs pr on pr.person_id = cs.person_id and pr.tenant_id = cs.tenant_id
       join public.glofox_transactions gt
         on gt.tenant_id = cs.tenant_id and gt.person_external_ref = pr.external_ref
       where cs.tenant_id = $1
         and cl.status in ('sent', 'delivered')
         and gt.transaction_status = 'PAID'
         and coalesce(gt.transaction_created_at, gt.created_at) >= cl.updated_at
         and coalesce(gt.transaction_created_at, gt.created_at) <= cl.updated_at + ($2::text || ' days')::interval
     ), inserted as (
       insert into public.campaign_attributions
         (tenant_id, campaign_send_id, person_id, event_type, event_ref, occurred_at, window_days)
       select tenant_id, campaign_send_id, person_id, event_type, event_ref, occurred_at, $2
       from candidate_events
       on conflict (campaign_send_id, event_type, event_ref) do nothing
       returning id
     )
     select count(*)::int as attributed from inserted`,
    [tenantId, windowDays],
  );
  const count = (result.rows[0] as { attributed?: unknown } | undefined)?.attributed;
  await pool.query(
    `update public.campaigns c
     set status = 'sent'
     where c.tenant_id = $1
       and c.status = 'sending'
       and not exists (
         select 1
         from public.campaign_sends cs
         left join public.comms_log cl
           on cl.id = cs.comms_log_id and cl.tenant_id = cs.tenant_id
         where cs.campaign_id = c.id
           and cs.planned_status = 'eligible'
           and (cs.comms_log_id is null or cl.status = 'queued')
       )`,
    [tenantId],
  );
  return typeof count === "number" ? count : 0;
}

export function createAttributionProcessor(): JobProcessor {
  return async (job, ctx) => {
    await attributeCampaigns(ctx.pool, tenantOf(job));
  };
}
