-- 0030 — tender alias normalization for the revenue-by-tender report.
--
-- Live /ask data (2026-07-18) showed Glofox emitting two labels for the same
-- real-world card tender: 'credit_card' (76 txns, $6,603.54) and 'card' (18
-- txns, $1,258.59) — a legacy/current label split, owner-confirmed 2026-07-18
-- as the same payment method. This split the per-tender breakdown into two rows
-- for one tender. (Net revenue totals are unaffected — the sum is identical
-- either way; only the grouping consolidates.)
--
-- Mirrors the plan_catalog.kelo_type pattern: a small reference table maps a raw
-- Glofox label to a canonical tender. Labels with no alias pass through
-- unchanged (the function coalesces to the raw label). cash and complimentary
-- are correctly distinct and get no alias.

create table if not exists public.tender_aliases (
  id           uuid primary key default gen_random_uuid(),
  glofox_label text not null unique,
  canonical    text not null,
  note         text,
  created_at   timestamptz not null default now()
);

comment on table public.tender_aliases is
  'Maps a raw Glofox payment_method label to a canonical tender for reporting. Global reference data (no tenant_id) — Glofox tender labels are platform conventions, not studio-specific. Labels absent here pass through unchanged.';

-- Global reference data: RLS enabled + authenticated read (using true), no
-- client writes — the same posture as ask_catalog / metric_definitions.
alter table public.tender_aliases enable row level security;
drop policy if exists tender_aliases_select on public.tender_aliases;
create policy tender_aliases_select on public.tender_aliases
  for select to authenticated using (true);
revoke all on public.tender_aliases from anon, authenticated, service_role;
grant select on public.tender_aliases to authenticated, service_role;

-- Only the actual normalization is seeded; identity mappings are unnecessary
-- (the function passes unmapped labels through).
insert into public.tender_aliases (glofox_label, canonical, note) values
  ('credit_card', 'card',
   'Owner-confirmed 2026-07-18: card == credit_card (Glofox legacy/current label split for the same card tender).')
on conflict (glofox_label) do nothing;

-- Re-emit ask_revenue_by_tender (cannot edit applied 0021) with a left join to
-- tender_aliases so equivalent labels collapse to one canonical tender. The
-- NOEQL relationship-override exclusion is preserved verbatim.
create or replace function public.ask_revenue_by_tender(
  p_tenant uuid, p_from date, p_to date
)
returns table (tender text, gross numeric, refunds numeric, net numeric, txn_count int)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  ), eligible as (
    select coalesce(ta.canonical, nullif(btrim(gt.payment_method), ''), 'unknown') as tender,
           gt.transaction_status, gt.amount
    from public.glofox_transactions gt
    cross join tenant_location tl
    left join public.tender_aliases ta
      on ta.glofox_label = nullif(btrim(gt.payment_method), '')
    where gt.tenant_id = p_tenant
      and gt.transaction_status in ('PAID', 'REFUNDED')
      and (gt.transaction_created_at at time zone tl.timezone)::date between p_from and p_to
      and not exists (
        select 1 from public.relationship_overrides ro
        where ro.tenant_id = p_tenant and ro.active
          and (
            ro.person_external_ref = gt.person_external_ref
            or exists (
              select 1 from public.people p
              join public.person_external_refs per
                on per.tenant_id = p.tenant_id and per.person_id = p.id
               and per.system = 'glofox'
              where p.tenant_id = p_tenant
                and p.external_ref = ro.person_external_ref
                and per.external_ref = gt.person_external_ref
            )
          )
      )
  )
  select e.tender,
         coalesce(sum(e.amount) filter (where e.transaction_status = 'PAID'), 0)::numeric,
         coalesce(sum(-abs(e.amount)) filter (where e.transaction_status = 'REFUNDED'), 0)::numeric,
         (coalesce(sum(e.amount) filter (where e.transaction_status = 'PAID'), 0)
           + coalesce(sum(-abs(e.amount)) filter (where e.transaction_status = 'REFUNDED'), 0))::numeric,
         count(*)::int
  from eligible e group by e.tender order by 4 desc, e.tender;
$$;
