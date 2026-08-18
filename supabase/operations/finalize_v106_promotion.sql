-- Post-live-E2E finalization. Fence predecessor issuance only; retain settlement/reconcile for immutable late Finals.
begin;

-- Late predecessor Finals remain valid after finalization. Restore the immutable
-- identity-bound completion surface idempotently before fencing predecessor issuance.
-- Legacy settled persistence is intentionally revoked because it can create rows
-- without a predecessor issuance identity.
grant execute on function public.settle_v105_prediction(jsonb, jsonb) to service_role;
grant execute on function public.reconcile_v105_prediction_lifecycle(text, text, text, integer) to service_role;
grant execute on function public.get_v105_prediction_lifecycle_stats() to service_role;
revoke execute on function public.persist_v105_settled_round(jsonb, jsonb) from service_role;

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where version = 'v106' and status = 'active') then
    raise exception 'v106 must be sole Active before finalization';
  end if;
  if not exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v106' and settlement_final is true
  ) then
    raise exception 'v106 has no verified Final settlement; finalization aborted';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v105'
      and prediction_issued_at is not null
      and settlement_final is not true
      and coalesce(issuance_status, 'pending') not in ('expired_no_final', 'abandoned_shoe_change')
  ) then
    raise exception 'v105 still has non-terminal unsettled immutable issuances; finalization aborted';
  end if;
end;
$$;

revoke execute on function public.issue_v105_prediction(jsonb) from service_role;
-- Do not revoke v105 settlement, legacy settled persistence, reconcile, or stats.
-- V106 runtime remains able to settle immutable v105 identities after promotion.

commit;
