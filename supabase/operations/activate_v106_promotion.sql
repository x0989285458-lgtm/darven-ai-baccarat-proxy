-- Controlled v106 activation. Run only after the producer is stopped and Queue/ACK is drained.
begin;

-- Idempotently restore the successor writer surface in case this is a verified
-- re-activation after rollback. Never restore predecessor issuance here.
grant execute on function public.issue_v106_prediction(jsonb) to service_role;
grant execute on function public.settle_v106_prediction(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_v106_prediction_lifecycle(text, text, text, integer) to service_role;
grant execute on function public.get_v106_prediction_lifecycle_stats() to service_role;
grant execute on function public.settle_v105_prediction(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_v105_prediction_lifecycle(text, text, text, integer) to service_role;
grant execute on function public.get_v105_prediction_lifecycle_stats() to service_role;
revoke execute on function public.persist_v105_settled_round(jsonb, jsonb) from service_role;

do $$
begin
  perform 1
  from public.ai_strategy_versions
  where version in ('v105', 'v106')
  order by version
  for update;
  if not exists (select 1 from public.ai_strategy_versions where version = 'v106') then
    raise exception 'v106 additive migration is missing';
  end if;
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where version = 'v105' and status = 'active') then
    raise exception 'activation requires v105 as the sole Active predecessor';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v105'
      and prediction_issued_at is not null
      and settlement_final is not true
      and coalesce(issuance_status, 'pending') not in ('expired_no_final', 'abandoned_shoe_change')
  ) then
    raise exception 'v105 still has non-terminal unsettled immutable issuances; activation aborted';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v105'
      and prediction_issued_at is not null
      and settlement_final is not true
      and issuance_status in ('expired_no_final', 'abandoned_shoe_change')
  ) and not has_function_privilege('service_role', 'public.settle_v105_prediction(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'v105 non-Final lifecycle rows still exist but predecessor settlement permission is missing';
  end if;
end;
$$;

update public.v105_shadow_v10_rank_sync_runtime_settings
set enabled = false, status = 'shadow_disabled', updated_at = now()
where release_candidate = 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized';

update public.ai_strategy_versions
set status = 'archived'
where status = 'active' and version <> 'v106';

update public.ai_strategy_versions
set status = 'active', activated_at = now()
where version = 'v106';

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where version = 'v106' and status = 'active') then
    raise exception 'v106 activation did not establish exactly one Active strategy';
  end if;
  if exists (
    select 1 from public.v105_shadow_v10_rank_sync_runtime_settings
    where release_candidate = 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
      and (enabled is true or status <> 'shadow_disabled')
  ) then
    raise exception 'promoted V10 shadow issuance remains enabled';
  end if;
end;
$$;

commit;
