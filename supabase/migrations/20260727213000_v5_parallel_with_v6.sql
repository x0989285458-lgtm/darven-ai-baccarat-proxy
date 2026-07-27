-- Resume the approved V5 shadow beside V6 while formal v105 remains the sole Active strategy.
-- V5 strategy identity, weights, thresholds, tables, counters, and evidence remain unchanged.
begin;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid='public.v104_iteration_shadow_v5_runtime_settings'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) like '%active_strategy_version%'
  loop
    execute format('alter table public.v104_iteration_shadow_v5_runtime_settings drop constraint %I', constraint_name);
  end loop;
end;
$$;
alter table public.v104_iteration_shadow_v5_runtime_settings
  add constraint v104_iteration_shadow_v5_runtime_settings_active_strategy_version_check
  check (active_strategy_version in ('v104','v105'));

do $$
declare
  function_name regprocedure;
  definition text;
begin
  foreach function_name in array array[
    'public.issue_v104_iteration_shadow_v5_prediction(jsonb)'::regprocedure,
    'public.settle_v104_iteration_shadow_v5_prediction(jsonb)'::regprocedure,
    'public.persist_v104_iteration_shadow_v5_artifacts(jsonb,jsonb)'::regprocedure,
    'public.review_v104_iteration_shadow_v5_suggestion(text,text,text)'::regprocedure
  ] loop
    definition := pg_get_functiondef(function_name);
    if function_name = 'public.issue_v104_iteration_shadow_v5_prediction(jsonb)'::regprocedure then
      definition := regexp_replace(
        definition,
        'version\s*=\s*''v104''',
        'version=''v105''',
        'g'
      );
      if definition !~ 'version\s*=\s*''v105''' then
        raise exception 'V5 issuance Active v105 guard rewrite failed';
      end if;
      if definition !~ 'v104-seven-head-shadow-v5-best-stage-side-reweight' then
        raise exception 'V5 issuance strategy identity was not preserved';
      end if;
    end if;
    definition := regexp_replace(
      definition,
      'active_strategy_version\s*=\s*''v104''',
      'active_strategy_version=''v105''',
      'g'
    );
    if definition ~ 'active_strategy_version\s*=\s*''v104''' then
      raise exception 'V5 active strategy runtime guard rewrite failed for %', function_name;
    end if;
    execute definition;
  end loop;
end;
$$;

insert into public.v104_iteration_shadow_v5_sequence_counters (
  release_candidate, settlement_count
) values ('v104.5.0-seven-head-shadow.5',0)
on conflict (release_candidate) do nothing;

update public.v104_iteration_shadow_v5_runtime_settings
set enabled=true,
    status='shadow',
    active_strategy_version='v105',
    updated_at=now()
where release_candidate='v104.5.0-seven-head-shadow.5'
  and strategy_version='v104-seven-head-shadow-v5-best-stage-side-reweight';

revoke all on function public.issue_v104_iteration_shadow_v5_prediction(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.settle_v104_iteration_shadow_v5_prediction(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.persist_v104_iteration_shadow_v5_artifacts(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_v104_iteration_shadow_v5_suggestion(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.issue_v104_iteration_shadow_v5_prediction(jsonb) to service_role;
grant execute on function public.settle_v104_iteration_shadow_v5_prediction(jsonb) to service_role;
grant execute on function public.persist_v104_iteration_shadow_v5_artifacts(jsonb,jsonb) to service_role;
grant execute on function public.review_v104_iteration_shadow_v5_suggestion(text,text,text) to service_role;

commit;
