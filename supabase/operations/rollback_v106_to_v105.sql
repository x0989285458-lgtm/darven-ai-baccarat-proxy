-- Non-destructive rollback. Run only after producer stop and every non-terminal v106 immutable issuance is Final.
begin;

do $$
begin
  perform 1
  from public.ai_strategy_versions
  where version in ('v105', 'v106')
  order by version
  for update;
  if not exists (select 1 from public.ai_strategy_versions where version = 'v105') then
    raise exception 'v105 rollback target is missing';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v106'
      and prediction_issued_at is not null
      and settlement_final is not true
      and coalesce(issuance_status, 'pending') not in ('expired_no_final', 'abandoned_shoe_change')
  ) then
    raise exception 'v106 still has non-terminal unsettled immutable issuances; rollback aborted';
  end if;
end;
$$;

revoke execute on function public.issue_v106_prediction(jsonb) from service_role;
-- Retain successor settlement/reconcile/stats during and after rollback so immutable
-- v106 evidence never loses its only DB completion path. New v106 issuance stays fenced.
grant execute on function public.settle_v106_prediction(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_v106_prediction_lifecycle(text, text, text, integer) to service_role;
grant execute on function public.get_v106_prediction_lifecycle_stats() to service_role;

grant execute on function public.issue_v105_prediction(jsonb) to service_role;
grant execute on function public.settle_v105_prediction(jsonb, jsonb) to service_role;
grant execute on function public.persist_v105_settled_round(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_v105_prediction_lifecycle(text, text, text, integer) to service_role;
grant execute on function public.get_v105_prediction_lifecycle_stats() to service_role;

update public.ai_strategy_versions
set status = 'archived'
where version = 'v106';

update public.ai_strategy_versions
set status = 'archived'
where status = 'active' and version <> 'v105';

update public.ai_strategy_versions
set status = 'active', activated_at = now()
where version = 'v105';

update public.v105_shadow_v10_rank_sync_runtime_settings
set status = 'shadow', enabled = true, active_strategy_version = 'v105', updated_at = now()
where release_candidate = 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized';

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where version = 'v105' and status = 'active') then
    raise exception 'rollback did not restore v105 as sole Active';
  end if;
  if not exists (
    select 1 from public.v105_shadow_v10_rank_sync_runtime_settings
    where release_candidate = 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
      and status = 'shadow' and enabled is true and active_strategy_version = 'v105'
  ) then
    raise exception 'rollback did not restore the exact v105 V10 shadow runtime tuple';
  end if;
end;
$$;

commit;
