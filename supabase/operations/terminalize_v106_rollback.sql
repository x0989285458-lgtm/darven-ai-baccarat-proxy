-- Evidence-preserving formal v106 rollback terminalization.
-- Run only after Proxy and Worker producer admission are stopped. This transaction
-- fences new v106 issuance, proves a quiet interval, terminalizes unresolved
-- immutable issuances, and isolates unfinished outbox payloads without deletion.
begin;

select pg_advisory_xact_lock(hashtext('formal_v106_rollback_terminalize_v106'));
-- Exclusive capture-source barrier waits for every in-flight Raw ACK shared lock,
-- then the RPC revoke keeps late ingest fenced until rollback restores v105.
select pg_advisory_xact_lock(hashtextextended('v105_capture_source_fence:capture', 0));

-- The UPDATE takes the exclusive half of the successor issuance row barrier.
-- It waits for every transaction that already passed issue_v106_prediction's
-- FOR SHARE admission check, then keeps all later calls fail-closed.
update public.ai_strategy_versions
set issuance_enabled = false
where version = 'v106';

revoke execute on function public.issue_v106_prediction(jsonb) from service_role;
revoke execute on function public.persist_v105_capture_envelope(jsonb) from service_role;
revoke execute on function public.persist_v105_fenced_capture_envelope(jsonb) from service_role;

do $$
declare
  terminalization_started_at timestamptz := clock_timestamp();
  quiet_before_at timestamptz;
  max_v106_issued_at timestamptz;
  active_strategy_activated_at timestamptz;
  active_cutover_generation uuid;
  receipt_generation uuid;
  terminalized_count integer := 0;
  isolated_outbox_count integer := 0;
  unresolved_after_count integer := 0;
  active_outbox_after_count integer := 0;
begin
  quiet_before_at := terminalization_started_at - interval '15 seconds';
  if has_function_privilege('service_role', 'public.issue_v106_prediction(jsonb)', 'EXECUTE') then
    raise exception 'v106 issuance RPC is not fenced';
  end if;

  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (
       select 1
       from public.ai_strategy_versions
       where version = 'v106' and status = 'active'
     ) then
    raise exception 'v106 must remain the sole Active successor during rollback terminalization';
  end if;
  select activated_at, cutover_generation
  into active_strategy_activated_at, active_cutover_generation
  from public.ai_strategy_versions
  where version = 'v106' and status = 'active'
  for update;
  if active_strategy_activated_at is null or active_cutover_generation is null then
    raise exception 'v106 activation generation identity is missing';
  end if;
  receipt_generation := active_cutover_generation;

  if exists (
    select 1
    from public.daily_prediction_results
    where strategy_version = 'v106'
      and prediction_issued_at is not null
      and prediction_issued_at > quiet_before_at
  ) then
    raise exception 'v106 producer quiet period is not proven';
  end if;

  update public.daily_prediction_results
  set issuance_status = 'expired_no_final',
      issuance_status_updated_at = terminalization_started_at,
      issuance_status_reason = case
        when issuance_status_reason like 'formal_v106_rollback_after_producer_stop%' then issuance_status_reason
        else 'formal_v106_rollback_after_producer_stop|previous:' || coalesce(issuance_status_reason, '')
      end
  where strategy_version = 'v106'
    and prediction_issued_at is not null
    and settlement_final is not true;
  get diagnostics terminalized_count = row_count;

  update public.v105_capture_settlement_outbox
  set status = 'dead_letter',
      claim_token = null,
      locked_at = null,
      next_attempt_at = null,
      isolated_at = now(),
      last_error = coalesce(nullif(last_error, ''), 'formal_v106_rollback_after_producer_stop'),
      updated_at = now()
  where status in ('pending', 'processing', 'error');
  get diagnostics isolated_outbox_count = row_count;

  select max(prediction_issued_at)
  into max_v106_issued_at
  from public.daily_prediction_results
  where strategy_version = 'v106'
    and prediction_issued_at is not null;

  select count(*)
  into unresolved_after_count
  from public.daily_prediction_results
  where strategy_version = 'v106'
    and prediction_issued_at is not null
    and settlement_final is not true
    and issuance_status is distinct from 'expired_no_final';

  select count(*)
  into active_outbox_after_count
  from public.v105_capture_settlement_outbox
  where status in ('pending', 'processing', 'error');

  if exists (
    select 1
    from public.daily_prediction_results
    where strategy_version = 'v106'
      and prediction_issued_at is not null
      and settlement_final is not true
      and issuance_status is distinct from 'expired_no_final'
  ) then
    raise exception 'v106 non-terminal issuance remains after rollback terminalization';
  end if;

  if exists (
    select 1
    from public.v105_capture_settlement_outbox
    where status in ('pending', 'processing', 'error')
  ) then
    raise exception 'active outbox remains after rollback terminalization';
  end if;

  insert into public.v106_rollback_terminalization_receipts (
    reason, started_at, quiet_before, completed_at, max_v106_issued_at,
    cutover_generation, strategy_activated_at,
    terminalized_issuance_count, isolated_outbox_count,
    unresolved_after_count, active_outbox_after_count
  ) values (
    'formal_v106_rollback_after_producer_stop', terminalization_started_at,
    quiet_before_at, clock_timestamp(), max_v106_issued_at,
    receipt_generation, active_strategy_activated_at,
    terminalized_count, isolated_outbox_count,
    unresolved_after_count, active_outbox_after_count
  );

  raise notice 'terminalized v106 rollback issuances: %, isolated active outbox: %',
    terminalized_count, isolated_outbox_count;
end;
$$;

commit;
