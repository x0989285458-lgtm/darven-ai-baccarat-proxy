-- Run only after the v105 Proxy and Worker pass live E2E.
-- Retains all v104 functions and evidence for rollback; removes predecessor write access only.

begin;

do $$
declare
  lifecycle jsonb;
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v105') then
    raise exception 'v105 must be the only active strategy before cutover finalization';
  end if;
  select public.get_v104_prediction_lifecycle_stats() into lifecycle;
  if coalesce((lifecycle->>'active_pending')::bigint, -1) <> 0 then
    raise exception 'v104 active_pending must be 0 before cutover finalization';
  end if;
end;
$$;

revoke execute on function public.get_v104_prediction_lifecycle_stats() from service_role;
revoke execute on function public.reconcile_v104_prediction_lifecycle(text, text, text, integer) from service_role;
revoke execute on function public.persist_v104_settled_round(jsonb, jsonb) from service_role;
revoke execute on function public.settle_v104_prediction(jsonb, jsonb) from service_role;
revoke execute on function public.issue_v104_prediction(jsonb) from service_role;
revoke execute on function public.apply_v104_rank_ledger_event(jsonb, jsonb) from service_role;

commit;
