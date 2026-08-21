begin;

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
    '20260821030000'
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
     or p_release_version <> 'v106.0.0-formal.48'
     or p_package_version <> '1.0.105' then
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
