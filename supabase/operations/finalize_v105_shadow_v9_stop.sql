-- Drain-safe V9 manual stop, phase 2: only fence settlement after every issued prediction is Final.
begin;

do $$
declare
  pending_count integer;
begin
  perform 1
  from public.v105_shadow_v9_runtime_settings
  where release_candidate='v105-shadow-v9-weighted-v7-v8'
    and strategy_version='v105-shadow-v9-weighted-v7-v8'
    and enabled=false
    and status='shadow_disabled'
    and active_strategy_version='v105'
  for update;
  if not found then
    raise exception 'V9 must be in shadow_disabled drain state before final stop';
  end if;

  select count(*) into pending_count
  from public.v105_shadow_v9_issuances i
  left join public.v105_shadow_v9_settlements s on s.prediction_id=i.id
  where s.prediction_id is null;
  if pending_count <> 0 then
    raise exception 'V9 pending issuance count must be zero before final stop: %', pending_count;
  end if;
end;
$$;

revoke execute on function public.issue_v105_shadow_v9_prediction(jsonb) from service_role;
revoke execute on function public.settle_v105_shadow_v9_prediction(jsonb) from service_role;

do $$
begin
  if has_function_privilege('service_role','public.issue_v105_shadow_v9_prediction(jsonb)','EXECUTE')
     or has_function_privilege('service_role','public.settle_v105_shadow_v9_prediction(jsonb)','EXECUTE') then
    raise exception 'V9 mutating RPCs are still callable after final stop';
  end if;
  if (select count(*) from public.ai_strategy_versions where lower(status)='active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where lower(status)='active' and version='v105') then
    raise exception 'v105 must remain the only Active strategy';
  end if;
end;
$$;

commit;
