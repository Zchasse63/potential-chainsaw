import { z } from "zod";
import type { Queryable } from "../processors.js";
import { candidateSchema, type Candidate } from "./types.js";

const candidateRowsSchema = z.array(candidateSchema);

/**
 * The candidate generator is one deterministic SQL statement. Every window,
 * comparison, threshold, impact score, and affected-person set is computed in
 * Postgres. TypeScript only validates and transports its result.
 */
export async function buildCandidates(pool: Queryable, tenantId: string): Promise<Candidate[]> {
  const result = await pool.query(
    `with tenant_clock as (
       select
         (now() at time zone l.timezone)::date as today
       from public.locations l
       where l.tenant_id = $1::uuid
       order by l.created_at, l.id
       limit 1
     ), revenue as (
       select
         current_period.net::float8 as current_net,
         prior_period.net::float8 as prior_net,
         (current_period.net - prior_period.net)::float8 as delta_net,
         case
           when prior_period.net = 0 then null
           else round((((current_period.net - prior_period.net) / abs(prior_period.net)) * 100)::numeric, 2)::float8
         end as delta_percent,
         tc.today
       from tenant_clock tc
       cross join lateral public.kpi_collected_revenue_totals($1::uuid, tc.today - 6, tc.today) current_period
       cross join lateral public.kpi_collected_revenue_totals($1::uuid, tc.today - 13, tc.today - 7) prior_period
     ), failed as (
       select fp.failed_count, fp.failed_sum::float8, fp.people
       from public.kpi_failed_payments($1::uuid, 30) fp
     ), ranked_runs as (
       select sr.id, sr.finished_at, row_number() over (
         order by sr.finished_at desc, sr.created_at desc, sr.id desc
       ) as run_rank
       from public.segment_runs sr
       where sr.tenant_id = $1::uuid and sr.status = 'success'
     ), segment_counts as (
       select
         sa.segment_key,
         rr.run_rank,
         count(*)::int as person_count,
         array_agg(sa.person_id order by sa.person_id) as person_ids
       from ranked_runs rr
       join public.segment_assignments sa
         on sa.run_id = rr.id and sa.tenant_id = $1::uuid
       where rr.run_rank <= 2
         and sa.segment_key in ('at_risk', 'credits_expiring', 'hooked')
       group by sa.segment_key, rr.run_rank
     ), segment_pivot as (
       select
         keys.segment_key,
         coalesce((
           select sc.person_count from segment_counts sc
           where sc.segment_key = keys.segment_key and sc.run_rank = 1
         ), 0)::int as current_count,
         coalesce((
           select sc.person_count from segment_counts sc
           where sc.segment_key = keys.segment_key and sc.run_rank = 2
         ), 0)::int as prior_count,
         coalesce((
           select sc.person_ids from segment_counts sc
           where sc.segment_key = keys.segment_key and sc.run_rank = 1
         ), '{}'::uuid[]) as person_ids,
         (select count(*)::int from ranked_runs rr where rr.run_rank <= 2) as compared_runs
       from (values ('at_risk'), ('credits_expiring'), ('hooked')) keys(segment_key)
     ), latest_per_entity as (
       -- Keep candidate health aligned with the refusal fence: only the
       -- current reconciliation state matters, not superseded drift history.
       select distinct on (r.entity) r.entity, r.status,
         abs(coalesce(r.drift_count, 0)) as drift_count, r.checked_at
       from public.reconciliations r
       where r.tenant_id = $1::uuid
         and r.checked_at >= now() - interval '48 hours'
       order by r.entity, r.checked_at desc
     ), health as (
       select
         count(*)::int as drift_rows,
         coalesce(sum(l.drift_count), 0)::int as drift_count,
         coalesce(array_agg(l.entity order by l.entity), '{}'::text[]) as entities,
         max(l.checked_at) as latest_checked_at
       from latest_per_entity l
       where l.status = 'drift'
     )
     select * from (
       select
         'revenue:7d_delta'::text as id,
         'revenue'::text as category,
         jsonb_strip_nulls(jsonb_build_object(
           'current_net', r.current_net,
           'prior_net', r.prior_net,
           'delta_net', r.delta_net,
           'delta_percent', r.delta_percent,
           'window_days', 7,
           'threshold_percent', 20
         )) as headline_facts,
         abs(r.delta_net)::float8 as impact_score,
         jsonb_build_object(
           'metric_refs', jsonb_build_array('collected_revenue'),
           'segment_keys', '[]'::jsonb,
           'person_ids', '[]'::jsonb,
           'current_from', r.today - 6,
           'current_to', r.today,
           'prior_from', r.today - 13,
           'prior_to', r.today - 7
         ) as evidence
       from revenue r
       where (r.prior_net <> 0 and abs(r.delta_percent) > 20)
          or (r.prior_net = 0 and r.current_net <> 0)

       union all

       select
         'payment_risk:outstanding',
         'payments',
         jsonb_build_object(
           'failed_count', f.failed_count,
           'failed_sum', f.failed_sum,
           'people', f.people,
           'window_days', 30
         ),
         abs(f.failed_sum)::float8,
         jsonb_build_object(
           'metric_refs', jsonb_build_array('failed_payments_outstanding'),
           'segment_keys', jsonb_build_array('payment_risk'),
           'person_ids', coalesce((
             select jsonb_agg(s.person_id order by s.person_id)
             from public.segment_current($1::uuid) s
             where s.segment_key = 'payment_risk'
           ), '[]'::jsonb)
         )
       from failed f
       where f.failed_sum > 0

       union all

       select
         'at_risk:growth',
         'retention',
         jsonb_build_object(
           'current_count', sp.current_count,
           'prior_count', sp.prior_count,
           'growth_count', sp.current_count - sp.prior_count,
           'threshold_growth', 3
         ),
         ((sp.current_count - sp.prior_count) * 100)::float8,
         jsonb_build_object(
           'metric_refs', '[]'::jsonb,
           'segment_keys', jsonb_build_array('at_risk'),
           'person_ids', to_jsonb(sp.person_ids)
         )
       from segment_pivot sp
       where sp.segment_key = 'at_risk'
         and sp.compared_runs = 2
         and sp.current_count - sp.prior_count >= 3

       union all

       select
         'credits_expiring:cluster',
         'retention',
         jsonb_build_object('people', sp.current_count, 'cluster_threshold', 3),
         (sp.current_count * 25)::float8,
         jsonb_build_object(
           'metric_refs', '[]'::jsonb,
           'segment_keys', jsonb_build_array('credits_expiring'),
           'person_ids', to_jsonb(sp.person_ids)
         )
       from segment_pivot sp
       where sp.segment_key = 'credits_expiring' and sp.current_count >= 3

       union all

       select
         'hooked:conversion_opportunity',
         'conversion',
         jsonb_build_object('people', sp.current_count, 'threshold_people', 3),
         (sp.current_count * 75)::float8,
         jsonb_build_object(
           'metric_refs', '[]'::jsonb,
           'segment_keys', jsonb_build_array('hooked'),
           'person_ids', to_jsonb(sp.person_ids)
         )
       from segment_pivot sp
       where sp.segment_key = 'hooked' and sp.current_count >= 3

       union all

       select
         'data_health:reconciliation_drift',
         'data_health',
         jsonb_build_object('drift_rows', h.drift_rows, 'drift_count', h.drift_count),
         greatest(h.drift_count, h.drift_rows)::float8 * 1000,
         jsonb_build_object(
           'metric_refs', '[]'::jsonb,
           'segment_keys', '[]'::jsonb,
           'person_ids', '[]'::jsonb,
           'entities', to_jsonb(h.entities),
           'latest_checked_at', h.latest_checked_at
         )
       from health h
       where h.drift_rows > 0
     ) candidates
     order by impact_score desc, id`,
    [tenantId],
  );

  const parsed = candidateRowsSchema.safeParse(result.rows);
  if (!parsed.success) {
    throw new Error(`briefing candidate query returned an invalid shape: ${parsed.error.message}`);
  }
  return parsed.data;
}
