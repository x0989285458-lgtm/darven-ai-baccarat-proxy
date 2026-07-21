-- Run only after the v104 Proxy and Worker pass live E2E.
-- Retains all v102 functions and evidence for rollback; removes predecessor write access only.

begin;

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v104') then
    raise exception 'v104 must be the only active strategy before cutover finalization';
  end if;
end;
$$;

revoke execute on function public.get_v102_prediction_lifecycle_stats() from service_role;
revoke execute on function public.reconcile_v102_prediction_lifecycle(text, text, text, integer) from service_role;
revoke execute on function public.persist_v102_settled_round(jsonb, jsonb) from service_role;
revoke execute on function public.settle_v102_prediction(jsonb, jsonb) from service_role;
revoke execute on function public.issue_v102_prediction(jsonb) from service_role;
revoke execute on function public.apply_v102_rank_ledger_event(jsonb, jsonb) from service_role;

commit;
