-- Drain-safe V10 manual stop, phase 1: fence new issuance while preserving Final settlement.
begin;

do $$
begin
  perform 1
  from public.v105_shadow_v10_runtime_settings
  where release_candidate='v105-shadow-v10-uncommon-road-structure'
    and strategy_version='v105-shadow-v10-uncommon-road-structure'
    and active_strategy_version='v105'
  for update;
  if not found then
    raise exception 'V10 runtime identity is unavailable';
  end if;
end;
$$;

update public.v105_shadow_v10_runtime_settings
set enabled=false,status='shadow_disabled',updated_at=now()
where release_candidate='v105-shadow-v10-uncommon-road-structure'
  and strategy_version='v105-shadow-v10-uncommon-road-structure'
  and active_strategy_version='v105';

revoke execute on function public.issue_v105_shadow_v10_prediction(jsonb) from service_role;

do $$
begin
  if has_function_privilege('service_role','public.issue_v105_shadow_v10_prediction(jsonb)','EXECUTE') then
    raise exception 'V10 issuance is still callable after stop';
  end if;
  if not has_function_privilege('service_role','public.settle_v105_shadow_v10_prediction(jsonb)','EXECUTE') then
    raise exception 'V10 settlement must remain callable while draining';
  end if;
  if (select count(*) from public.ai_strategy_versions where lower(status)='active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where lower(status)='active' and version='v105') then
    raise exception 'v105 must remain the only Active strategy';
  end if;
end;
$$;

commit;
