-- Non-destructive rollback. Run only after producer stop and a durable Formal.17
-- terminalization receipt proves quiet, bounded lifecycle closure and zero active outbox.
begin;

select pg_advisory_xact_lock(hashtextextended('v105_capture_source_fence:capture', 0));

do $$
declare
  latest_receipt public.v106_rollback_terminalization_receipts%rowtype;
  active_strategy_activated_at timestamptz;
  active_cutover_generation uuid;
begin
  perform 1
  from public.ai_strategy_versions
  where version in ('v105', 'v106')
  order by version
  for update;
  if not exists (select 1 from public.ai_strategy_versions where version = 'v105') then
    raise exception 'v105 rollback target is missing';
  end if;
  select activated_at, cutover_generation
  into active_strategy_activated_at, active_cutover_generation
  from public.ai_strategy_versions
  where version = 'v106' and status = 'active';
  if active_strategy_activated_at is null or active_cutover_generation is null then
    raise exception 'active v106 activation generation identity is missing';
  end if;
  select * into latest_receipt
  from public.v106_rollback_terminalization_receipts
  where reason = 'formal_v106_rollback_after_producer_stop'
    and strategy_activated_at = active_strategy_activated_at
    and cutover_generation = active_cutover_generation
    and started_at >= active_strategy_activated_at
    and completed_at >= started_at
    and consumed_at is null
  order by completed_at desc
  limit 1
  for update;
  if latest_receipt.receipt_id is null
     or latest_receipt.unresolved_after_count <> 0
     or latest_receipt.active_outbox_after_count <> 0 then
    raise exception 'durable v106 rollback terminalization receipt is missing or incomplete';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v106'
      and prediction_issued_at is not null
      and prediction_issued_at > latest_receipt.quiet_before
  ) then
    raise exception 'v106 issuance exists after the receipt quiet cutoff';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v106'
      and prediction_issued_at is not null
      and settlement_final is not true
      and issuance_status = 'expired_no_final'
      and (
        coalesce(issuance_status_reason, '') not like 'formal_v106_rollback_after_producer_stop%'
        or issuance_status_updated_at < latest_receipt.started_at
        or issuance_status_updated_at > latest_receipt.completed_at
      )
  ) then
    raise exception 'expired v106 issuance is not covered by the durable rollback receipt';
  end if;
  if exists (
    select 1 from public.v105_capture_settlement_outbox
    where status in ('pending', 'processing', 'error')
  ) then
    raise exception 'active outbox appeared after rollback terminalization receipt';
  end if;
  if exists (
    select 1 from public.daily_prediction_results
    where strategy_version = 'v106'
      and prediction_issued_at is not null
      and settlement_final is not true
      and issuance_status is distinct from 'expired_no_final'
  ) then
    raise exception 'v106 still has non-terminal unsettled immutable issuances; rollback aborted';
  end if;
  update public.v106_rollback_terminalization_receipts
  set consumed_at = clock_timestamp(), consumed_by = 'rollback_v106_to_v105'
  where receipt_id = latest_receipt.receipt_id and consumed_at is null;
  if not found then
    raise exception 'v106 rollback receipt was already consumed';
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
grant execute on function public.persist_v105_capture_envelope(jsonb) to service_role;
grant execute on function public.persist_v105_fenced_capture_envelope(jsonb) to service_role;

update public.ai_strategy_versions
set status = 'archived'
where version = 'v106';

update public.ai_strategy_versions
set status = 'archived'
where status = 'active' and version <> 'v105';

update public.ai_strategy_versions
set status = 'active', activated_at = now(), cutover_generation = gen_random_uuid()
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
