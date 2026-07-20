-- Run only after the v102 Proxy and Worker pass live E2E.
-- Retains all v101 functions and evidence for rollback; removes predecessor write access only.

begin;

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v102') then
    raise exception 'v102 must be the only active strategy before cutover finalization';
  end if;
end;
$$;

revoke execute on function public.get_v101_prediction_lifecycle_stats() from service_role;
revoke execute on function public.reconcile_v101_prediction_lifecycle(text, text, text, integer) from service_role;
revoke execute on function public.persist_v101_settled_round(jsonb, jsonb) from service_role;
revoke execute on function public.settle_v101_prediction(jsonb, jsonb) from service_role;
revoke execute on function public.issue_v101_prediction(jsonb) from service_role;
revoke execute on function public.apply_v101_rank_ledger_event(jsonb, jsonb) from service_role;

commit;
