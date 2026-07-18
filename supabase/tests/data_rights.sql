-- Integration proof for migration 0025. Run after all migrations on the same
-- disposable/plain-Postgres database used by scripts/db-test.sh.
begin;

insert into auth.users (id, email)
values ('25250000-0000-4000-8000-000000000001', 'data-rights-owner@example.test')
on conflict (id) do nothing;
insert into public.tenants (id, name, slug)
values ('25250000-0000-4000-8000-000000000002', 'Data Rights Test', 'data-rights-test')
on conflict (id) do nothing;
insert into public.tenant_users (id, tenant_id, user_id, role)
values (
  '25250000-0000-4000-8000-000000000003',
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (tenant_id, user_id) do nothing;
insert into public.people (
  id, tenant_id, email, phone, first_name, last_name, address, external_ref
) values (
  '25250000-0000-4000-8000-000000000004',
  '25250000-0000-4000-8000-000000000002',
  'subject@example.test', '(212) 555-0100', 'Data', 'Subject',
  '{"line1":"1 Private Way"}'::jsonb, 'glofox-data-subject'
);
insert into public.comms_log (
  id, tenant_id, person_id, channel, subject, body_preview, to_address, status
) values (
  '25250000-0000-4000-8000-000000000005',
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000004',
  'email', 'Private subject', 'Private body', 'subject@example.test', 'sent'
);
insert into public.credit_ledger (
  id, tenant_id, person_id, entry_type, delta, external_ref
) values (
  '25250000-0000-4000-8000-000000000006',
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000004', 'grant', 5, 'credit-data-rights'
);
insert into public.glofox_transactions (
  id, tenant_id, external_ref, transaction_status, amount, currency,
  glofox_event_class, person_external_ref
) values (
  '25250000-0000-4000-8000-000000000007',
  '25250000-0000-4000-8000-000000000002', 'tx-data-rights', 'PAID', 10, 'USD',
  'invoice_payment', 'glofox-data-subject'
);
insert into public.person_relationship_log (
  id, tenant_id, person_id, from_primary, to_primary, basis, rule_version
) values (
  '25250000-0000-4000-8000-000000000008',
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000004', null, 'lead', '{"proof":"kept"}', 3
);

create temporary table data_rights_evidence_before (
  relation text primary key,
  payload jsonb not null
) on commit drop;
insert into data_rights_evidence_before
select 'credit_ledger', to_jsonb(cl) from public.credit_ledger cl
where cl.id = '25250000-0000-4000-8000-000000000006'
union all
select 'glofox_transactions', to_jsonb(t) from public.glofox_transactions t
where t.id = '25250000-0000-4000-8000-000000000007'
union all
select 'person_relationship_log', to_jsonb(r) from public.person_relationship_log r
where r.id = '25250000-0000-4000-8000-000000000008';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"25250000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select (app.pseudonymize_person(
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000004',
  '25250000-0000-4000-8000-000000000001',
  'integration test'
)).id;
reset role;

do $$
declare
  v_person public.people%rowtype;
  v_log public.comms_log%rowtype;
  v_changed int;
begin
  select * into v_person from public.people
  where id = '25250000-0000-4000-8000-000000000004';
  if v_person.first_name <> 'Deleted' or v_person.last_name is not null
     or v_person.email is not null or v_person.phone is not null
     or v_person.phone_e164 is not null or v_person.address is not null
     or v_person.deleted_at is null or v_person.pseudonym_label is null
     or v_person.active then
    raise exception 'DATA-RIGHTS-FAIL: people identity was not fully tombstoned';
  end if;

  if (select count(*) from public.comms_suppressions
      where person_id = v_person.id and reason = 'manual'
        and channel in ('email', 'sms')) <> 2 then
    raise exception 'DATA-RIGHTS-FAIL: both original addresses were not suppressed';
  end if;
  if (select count(*) from public.communication_consents
      where person_id = v_person.id and status = 'revoked'
        and channel in ('email', 'sms')) <> 2 then
    raise exception 'DATA-RIGHTS-FAIL: both consent channels were not revoked';
  end if;

  select * into v_log from public.comms_log
  where id = '25250000-0000-4000-8000-000000000005';
  if v_log.subject <> '[erased]' or v_log.body_preview <> '[erased]'
     or v_log.to_address <> '[erased]' then
    raise exception 'DATA-RIGHTS-FAIL: comms content/address was not scrubbed';
  end if;

  if (select count(*) from public.person_deletions
      where person_id = v_person.id and requested_by =
        '25250000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'DATA-RIGHTS-FAIL: erasure audit was not written';
  end if;

  select count(*) into v_changed
  from data_rights_evidence_before before
  where before.payload is distinct from case before.relation
    when 'credit_ledger' then (
      select to_jsonb(cl) from public.credit_ledger cl
      where cl.id = '25250000-0000-4000-8000-000000000006'
    )
    when 'glofox_transactions' then (
      select to_jsonb(t) from public.glofox_transactions t
      where t.id = '25250000-0000-4000-8000-000000000007'
    )
    when 'person_relationship_log' then (
      select to_jsonb(r) from public.person_relationship_log r
      where r.id = '25250000-0000-4000-8000-000000000008'
    )
  end;
  if v_changed <> 0 then
    raise exception 'DATA-RIGHTS-FAIL: append-only evidence changed';
  end if;
end
$$;

-- A second invocation returns the first audit and appends/touches nothing.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"25250000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select (app.pseudonymize_person(
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000004',
  '25250000-0000-4000-8000-000000000001',
  'duplicate integration test'
)).id;
reset role;

do $$
begin
  if (select count(*) from public.person_deletions
      where person_id = '25250000-0000-4000-8000-000000000004') <> 1
     or (select count(*) from public.communication_consents
         where person_id = '25250000-0000-4000-8000-000000000004') <> 2
     or (select count(*) from public.comms_suppressions
         where person_id = '25250000-0000-4000-8000-000000000004') <> 2 then
    raise exception 'DATA-RIGHTS-FAIL: repeated erasure was not idempotent';
  end if;
end
$$;

-- Retention cutoffs are strict and idempotent; deleting an AI artifact must
-- retain the append-only feedback row and its historical artifact identifier.
insert into public.comms_log (
  id, tenant_id, channel, subject, body_preview, to_address, status, created_at
) values
  ('25250000-0000-4000-8000-000000000011',
   '25250000-0000-4000-8000-000000000002', 'email', 'old', 'old body',
   'old@example.test', 'sent', now() - interval '731 days'),
  ('25250000-0000-4000-8000-000000000012',
   '25250000-0000-4000-8000-000000000002', 'email', 'new', 'new body',
   'new@example.test', 'sent', now() - interval '729 days');
insert into public.ai_artifacts (
  id, tenant_id, kind, generated_for, status, input, input_hash, created_at
) values
  ('25250000-0000-4000-8000-000000000013',
   '25250000-0000-4000-8000-000000000002', 'briefing', current_date - 366,
   'fallback', '{}'::jsonb, 'old-ai', now() - interval '366 days'),
  ('25250000-0000-4000-8000-000000000014',
   '25250000-0000-4000-8000-000000000002', 'briefing', current_date - 364,
   'fallback', '{}'::jsonb, 'new-ai', now() - interval '364 days');
insert into public.briefing_feedback (
  id, tenant_id, artifact_id, item_ref, verdict
) values (
  '25250000-0000-4000-8000-000000000015',
  '25250000-0000-4000-8000-000000000002',
  '25250000-0000-4000-8000-000000000013', 'old-item', 'up'
);

set local role service_role;
select app.apply_retention_policy(
  '25250000-0000-4000-8000-000000000002', 'comms_content', 730, 'scrub_body'
);
select app.apply_retention_policy(
  '25250000-0000-4000-8000-000000000002', 'ai_artifacts', 365, 'delete'
);
reset role;

do $$
begin
  if (select body_preview from public.comms_log
      where id = '25250000-0000-4000-8000-000000000011') <> '[retention-scrub]'
     or (select body_preview from public.comms_log
         where id = '25250000-0000-4000-8000-000000000012') <> 'new body' then
    raise exception 'DATA-RIGHTS-FAIL: comms retention cutoff was not age bounded';
  end if;
  if exists (select 1 from public.ai_artifacts
             where id = '25250000-0000-4000-8000-000000000013')
     or not exists (select 1 from public.ai_artifacts
                    where id = '25250000-0000-4000-8000-000000000014') then
    raise exception 'DATA-RIGHTS-FAIL: AI retention cutoff was not age bounded';
  end if;
  if not exists (
    select 1 from public.briefing_feedback
    where id = '25250000-0000-4000-8000-000000000015'
      and artifact_id = '25250000-0000-4000-8000-000000000013'
  ) then
    raise exception 'DATA-RIGHTS-FAIL: append-only feedback did not survive AI expiry';
  end if;
end
$$;

rollback;
select 'DATA RIGHTS SQL TEST PASSED' as result;
