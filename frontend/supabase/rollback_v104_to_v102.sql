-- Non-destructive application-first rollback from v104 to v102.
begin;

do $$
begin
  if not exists (select 1 from public.ai_strategy_versions where version = 'v102') then
    raise exception 'v102 rollback strategy is missing';
  end if;
  if not exists (select 1 from public.v104_formal_release_previous_active where version = 'v102') then
    raise exception 'v104 rollback provenance is missing';
  end if;
end;
$$;

-- Restore the predecessor writer atomically with the strategy rollback.
revoke execute on function public.get_v104_prediction_lifecycle_stats() from service_role;
revoke execute on function public.reconcile_v104_prediction_lifecycle(text, text, text, integer) from service_role;
revoke execute on function public.persist_v104_settled_round(jsonb, jsonb) from service_role;
revoke execute on function public.settle_v104_prediction(jsonb, jsonb) from service_role;
revoke execute on function public.issue_v104_prediction(jsonb) from service_role;
revoke execute on function public.apply_v104_rank_ledger_event(jsonb, jsonb) from service_role;

grant execute on function public.get_v102_prediction_lifecycle_stats() to service_role;
grant execute on function public.reconcile_v102_prediction_lifecycle(text, text, text, integer) to service_role;
grant execute on function public.persist_v102_settled_round(jsonb, jsonb) to service_role;
grant execute on function public.settle_v102_prediction(jsonb, jsonb) to service_role;
grant execute on function public.issue_v102_prediction(jsonb) to service_role;
grant execute on function public.apply_v102_rank_ledger_event(jsonb, jsonb) to service_role;

update public.ai_strategy_versions set status = 'archived' where status = 'active';
update public.ai_strategy_versions set status = 'active', activated_at = now() where version = 'v102';

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v102') then
    raise exception 'v102 must be the only active rollback strategy';
  end if;
end;
$$;

commit;
