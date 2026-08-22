begin;

create or replace function public.claim_v105_capture_settlement_outbox(p_limit integer default 10)
returns setof public.v105_capture_settlement_outbox
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  update public.v105_capture_settlement_outbox as poison
  set status = 'dead_letter', isolated_at = pg_catalog.now(), locked_at = null,
      next_attempt_at = null, claim_token = null, updated_at = pg_catalog.now()
  where poison.attempts >= 5
    and ((poison.status = 'error' and poison.next_attempt_at <= pg_catalog.now())
      or (poison.status = 'processing' and poison.locked_at < pg_catalog.now() - interval '5 minutes'));

  return query
  with target_session as (
    select head.session_id
    from public.v105_capture_settlement_outbox as head
    where head.attempts < 5
      and (
        head.status = 'pending'
        or (head.status = 'error' and head.next_attempt_at <= pg_catalog.now())
        or (head.status = 'processing' and head.locked_at < pg_catalog.now() - interval '5 minutes')
      )
      and not exists (
        select 1 from public.v105_capture_settlement_outbox as earlier
        where earlier.session_id = head.session_id
          and earlier.sequence < head.sequence
          and earlier.status not in ('completed','dead_letter')
      )
    order by head.created_at, head.id
    for update skip locked
    limit 1
  ), candidates as (
    select candidate.id
    from public.v105_capture_settlement_outbox as candidate
    join target_session on target_session.session_id = candidate.session_id
    where candidate.attempts < 5
      and (
        candidate.status = 'pending'
        or (candidate.status = 'error' and candidate.next_attempt_at <= pg_catalog.now())
        or (candidate.status = 'processing' and candidate.locked_at < pg_catalog.now() - interval '5 minutes')
      )
      and not exists (
        select 1 from public.v105_capture_settlement_outbox as blocker
        where blocker.session_id = candidate.session_id
          and blocker.sequence < candidate.sequence
          and blocker.status not in ('completed','dead_letter')
          and not (
            blocker.attempts < 5 and (
              blocker.status = 'pending'
              or (blocker.status = 'error' and blocker.next_attempt_at <= pg_catalog.now())
              or (blocker.status = 'processing' and blocker.locked_at < pg_catalog.now() - interval '5 minutes')
            )
          )
      )
    order by candidate.sequence, candidate.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  ), claimed as (
    update public.v105_capture_settlement_outbox as outbox
    set status = 'processing', attempts = outbox.attempts + 1,
        lease_generation = outbox.lease_generation + 1,
        claim_token = pg_catalog.gen_random_uuid(), locked_at = pg_catalog.now(),
        next_attempt_at = null, updated_at = pg_catalog.now(), last_error = null
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select claimed.* from claimed order by claimed.sequence, claimed.id;
end;
$$;

create or replace function public.complete_v105_capture_settlement_outbox_batch(p_claims jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare expected integer; matched integer; affected integer;
begin
  if pg_catalog.jsonb_typeof(p_claims) <> 'array' or pg_catalog.jsonb_array_length(p_claims) < 1 then
    raise exception 'capture outbox batch completion claims invalid';
  end if;
  select count(*) into expected from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer);
  select count(*) into matched
  from public.v105_capture_settlement_outbox as outbox
  join pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
    on outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
   and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt
  where outbox.status = 'processing';
  if matched <> expected then raise exception 'capture outbox stale batch completion rejected'; end if;
  update public.v105_capture_settlement_outbox as outbox
  set status = 'completed', processed_at = pg_catalog.now(), locked_at = null,
      next_attempt_at = null, claim_token = null, last_error = null, updated_at = pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
  where outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
    and outbox.status = 'processing' and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'capture outbox atomic batch completion rejected'; end if;
  return pg_catalog.jsonb_build_object('completed', true, 'count', affected);
end;
$$;

create or replace function public.fail_v105_capture_settlement_outbox_batch(p_claims jsonb, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare expected integer; matched integer; affected integer; isolated_count integer;
begin
  if pg_catalog.jsonb_typeof(p_claims) <> 'array' or pg_catalog.jsonb_array_length(p_claims) < 1 then
    raise exception 'capture outbox batch failure claims invalid';
  end if;
  select count(*) into expected from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer);
  select count(*) into matched
  from public.v105_capture_settlement_outbox as outbox
  join pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
    on outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
   and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt
  where outbox.status = 'processing';
  if matched <> expected then raise exception 'capture outbox stale batch failure rejected'; end if;
  update public.v105_capture_settlement_outbox as outbox
  set status = case when claim.attempt >= 5 then 'dead_letter' else 'error' end,
      isolated_at = case when claim.attempt >= 5 then pg_catalog.now() else null end,
      next_attempt_at = case when claim.attempt >= 5 then null else pg_catalog.now() + pg_catalog.make_interval(secs => least(300, (2 ^ least(claim.attempt, 8))::integer)) end,
      locked_at = null, claim_token = null,
      last_error = pg_catalog.left(coalesce(p_error, 'unknown error'), 500), updated_at = pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
  where outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
    and outbox.status = 'processing' and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'capture outbox atomic batch failure rejected'; end if;
  select count(*) into isolated_count from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer) where claim.attempt >= 5;
  return pg_catalog.jsonb_build_object('failed', true, 'count', affected, 'isolated_count', isolated_count);
end;
$$;

revoke all on function public.complete_v105_capture_settlement_outbox_batch(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fail_v105_capture_settlement_outbox_batch(jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.complete_v105_capture_settlement_outbox_batch(jsonb) to service_role;
grant execute on function public.fail_v105_capture_settlement_outbox_batch(jsonb,text) to service_role;

create or replace function public.verify_v106_production_cutover_gate(
  p_phase text,
  p_release_version text,
  p_package_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  required_migrations constant text[] := array[
    '20260820030000', '20260820040000', '20260820050000',
    '20260820060000', '20260821010000', '20260821020000',
    '20260821030000', '20260822010000'
  ];
  applied_migrations text[];
  active_count integer;
  active_version text;
  active_status text;
  active_generation uuid;
  v105_issuance_enabled boolean;
  v106_issuance_enabled boolean;
  receipt_required integer;
  inner_definition text;
  writer_acl jsonb;
  outbox_health jsonb;
  pending_count integer;
  processing_count integer;
  error_count integer;
  jwt_role text;
begin
  jwt_role := coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '');
  if jwt_role <> 'service_role' then
    raise exception 'v106 production DB gate requires service_role';
  end if;
  if p_phase not in ('pre', 'post')
     or p_release_version <> 'v106.0.0-formal.57'
     or p_package_version <> '1.0.114' then
    raise exception 'v106 production DB gate identity mismatch';
  end if;

  select coalesce(array_agg(version order by version), array[]::text[])
    into applied_migrations
  from supabase_migrations.schema_migrations
  where version = any(required_migrations);
  if applied_migrations <> (select array_agg(x order by x) from unnest(required_migrations) x) then
    raise exception 'v106 production DB gate migration provenance mismatch';
  end if;

  select count(*) into active_count
  from public.ai_strategy_versions
  where status = 'active';
  select version, status, cutover_generation
    into active_version, active_status, active_generation
  from public.ai_strategy_versions
  where status = 'active'
  limit 1;
  if active_count <> 1 or active_version <> 'v106' or active_status <> 'active' or active_generation is null then
    raise exception 'v106 production DB gate active generation mismatch';
  end if;
  select issuance_enabled into v105_issuance_enabled
  from public.ai_strategy_versions where version = 'v105';
  select issuance_enabled into v106_issuance_enabled
  from public.ai_strategy_versions where version = 'v106';
  if v105_issuance_enabled is distinct from false or v106_issuance_enabled is distinct from true then
    raise exception 'v106 production DB gate issuance admission mismatch';
  end if;

  select count(*) into receipt_required
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'v106_rollback_terminalization_receipts'
    and column_name in ('strategy_activated_at', 'cutover_generation')
    and is_nullable = 'NO';
  if receipt_required <> 2 then
    raise exception 'v106 production DB gate receipt provenance mismatch';
  end if;

  select pg_get_functiondef('public.persist_v105_capture_envelope(jsonb)'::regprocedure)
    into inner_definition;
  if position('pg_advisory_xact_lock_shared' in inner_definition) = 0
     or position('v105_capture_source_fence:capture' in inner_definition) = 0 then
    raise exception 'v106 production DB gate raw barrier mismatch';
  end if;

  writer_acl := jsonb_build_object(
    'issueV105', has_function_privilege('service_role', 'public.issue_v105_prediction(jsonb)', 'EXECUTE'),
    'issueV106', has_function_privilege('service_role', 'public.issue_v106_prediction(jsonb)', 'EXECUTE'),
    'settleV105', has_function_privilege('service_role', 'public.settle_v105_prediction(jsonb,jsonb)', 'EXECUTE'),
    'settleV106', has_function_privilege('service_role', 'public.settle_v106_prediction(jsonb,jsonb)', 'EXECUTE'),
    'rawDirect', has_function_privilege('service_role', 'public.persist_v105_capture_envelope(jsonb)', 'EXECUTE'),
    'rawFenced', has_function_privilege('service_role', 'public.persist_v105_fenced_capture_envelope(jsonb)', 'EXECUTE')
  );
  if writer_acl <> '{"issueV105":false,"issueV106":true,"settleV105":true,"settleV106":true,"rawDirect":false,"rawFenced":true}'::jsonb then
    raise exception 'v106 production DB gate writer ACL mismatch';
  end if;

  select public.get_v105_capture_outbox_health() into outbox_health;
  pending_count := coalesce((outbox_health ->> 'pending')::integer, 0);
  processing_count := coalesce((outbox_health ->> 'processing')::integer, 0);
  error_count := coalesce((outbox_health ->> 'error')::integer, 0);
  if p_phase = 'pre' and (pending_count <> 0 or processing_count <> 0 or error_count <> 0) then
    raise exception 'v106 production DB gate active Outbox is not drained';
  end if;
  if p_phase = 'post' and (pending_count + processing_count > 1 or error_count <> 0) then
    raise exception 'v106 production DB gate post-start Outbox is not bounded';
  end if;

  return jsonb_build_object(
    'ok', true,
    'phase', p_phase,
    'projectRef', 'gscfexhsqxvtpyxudtza',
    'release', p_release_version,
    'generation', active_generation::text,
    'migrations', applied_migrations,
    'writerAcl', writer_acl,
    'issuanceAdmission', jsonb_build_object(
      'v105', v105_issuance_enabled,
      'v106', v106_issuance_enabled
    ),
    'activeOutbox', jsonb_build_object(
      'pending', pending_count,
      'processing', processing_count,
      'error', error_count,
      'dead_letter', coalesce((outbox_health ->> 'dead_letter')::integer, 0)
    )
  );
end;
$$;

revoke all on function public.verify_v106_production_cutover_gate(text, text, text) from public, anon, authenticated;
grant execute on function public.verify_v106_production_cutover_gate(text, text, text) to service_role;

commit;
