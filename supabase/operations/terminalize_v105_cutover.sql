-- Formal v106 cutover terminalization. Run only after predecessor issuance is fenced
-- and every capture/issuance producer is stopped. Immutable prediction identity and
-- payload remain untouched so an authoritative late Final can still settle by ID.
begin;

select pg_advisory_xact_lock(hashtext('formal_v106_cutover_terminalize_v105'));

do $$
declare
  terminalized_count integer := 0;
begin
  if not exists (
    select 1 from public.ai_strategy_versions
    where version = 'v105' and issuance_enabled is false
  ) then
    raise exception 'v105 issuance row barrier is not closed';
  end if;

  if has_function_privilege('service_role', 'public.issue_v105_prediction(jsonb)', 'EXECUTE') then
    raise exception 'v105 issuance RPC is not fenced';
  end if;

  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (
       select 1 from public.ai_strategy_versions
       where version = 'v105' and status = 'active'
     ) then
    raise exception 'v105 must remain the sole Active predecessor during terminalization';
  end if;

  if exists (
    select 1
    from public.daily_prediction_results
    where strategy_version = 'v105'
      and prediction_issued_at is not null
      and prediction_issued_at > now() - interval '15 seconds'
  ) then
    raise exception 'v105 producer quiet period is not proven';
  end if;

  update public.daily_prediction_results
  set issuance_status = 'expired_no_final',
      issuance_status_updated_at = now(),
      issuance_status_reason = 'formal_v106_cutover_after_producer_stop'
  where strategy_version = 'v105'
    and prediction_issued_at is not null
    and settlement_final is not true
    and coalesce(issuance_status, 'pending') not in ('expired_no_final', 'abandoned_shoe_change');
  get diagnostics terminalized_count = row_count;

  if exists (
    select 1
    from public.daily_prediction_results
    where strategy_version = 'v105'
      and prediction_issued_at is not null
      and settlement_final is not true
      and coalesce(issuance_status, 'pending') not in ('expired_no_final', 'abandoned_shoe_change')
  ) then
    raise exception 'v105 non-terminal issuance remains after cutover terminalization';
  end if;

  raise notice 'terminalized v105 cutover issuances: %', terminalized_count;
end;
$$;

commit;
