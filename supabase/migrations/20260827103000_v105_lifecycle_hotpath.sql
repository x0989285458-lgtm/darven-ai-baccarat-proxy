-- Main50: bound v105 lifecycle reconciliation to the active pending issuance set.
-- DROP/CREATE INDEX CONCURRENTLY must run in psql autocommit mode, never inside BEGIN/COMMIT.
-- Rerun safety: a prior interrupted build may leave an invalid same-name index, so always drop it first.
-- MAIN50_STEP_DROP_INDEX
drop index concurrently if exists public.daily_prediction_results_v105_lifecycle_hot_idx;
-- MAIN50_STEP_CREATE_INDEX
create index concurrently daily_prediction_results_v105_lifecycle_hot_idx
  on public.daily_prediction_results (source, table_id, strategy_version, shoe_no, round_no)
  where prediction_issued_at is not null
    and settlement_final is not true
    and (issuance_status is null or issuance_status in ('pending', 'expired_no_final'));

-- MAIN50_STEP_FUNCTION_CUTOVER
create or replace function public.reconcile_v105_prediction_lifecycle(
  p_source text,
  p_table_id text,
  p_current_shoe text,
  p_current_visible_round integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  pending_count integer := 0;
  expired_count integer := 0;
  abandoned_count integer := 0;
  updated_count integer := 0;
begin
  if nullif(p_source, '') is null
     or nullif(p_table_id, '') is null
     or nullif(p_current_shoe, '') is null
     or p_current_visible_round is null
     or p_current_visible_round < 1 then
    raise exception 'prediction lifecycle reconciliation identity is incomplete';
  end if;

  with classified as (
    update public.daily_prediction_results
    set issuance_status = case
          when shoe_no is distinct from p_current_shoe then 'abandoned_shoe_change'
          when round_no < p_current_visible_round then 'expired_no_final'
          else 'pending'
        end,
        issuance_status_updated_at = pg_catalog.now(),
        issuance_status_reason = case
          when shoe_no is distinct from p_current_shoe then 'live_screen_shoe_changed_before_authoritative_final'
          when round_no < p_current_visible_round then 'live_screen_round_passed_without_authoritative_final'
          else 'live_screen_identity_current_or_future'
        end
    where strategy_version = 'v105'
      and source = p_source
      and table_id = p_table_id
      and prediction_issued_at is not null
      and settlement_final is not true
      and (issuance_status is null or issuance_status in ('pending', 'expired_no_final'))
      and (
        issuance_status is null
        or (
          issuance_status = 'pending'
          and (
            shoe_no is distinct from p_current_shoe
            or round_no < p_current_visible_round
          )
        )
        or (
          issuance_status = 'expired_no_final'
          and shoe_no is distinct from p_current_shoe
        )
      )
    returning issuance_status
  )
  select count(*) filter (where issuance_status = 'pending')::integer,
         count(*) filter (where issuance_status = 'expired_no_final')::integer,
         count(*) filter (where issuance_status = 'abandoned_shoe_change')::integer,
         count(*)::integer
    into pending_count, expired_count, abandoned_count, updated_count
  from classified;

  return pg_catalog.jsonb_build_object(
    'source', p_source,
    'table_id', p_table_id,
    'current_shoe', p_current_shoe,
    'current_visible_round', p_current_visible_round,
    'pending', pending_count,
    'expired_no_final', expired_count,
    'abandoned_shoe_change', abandoned_count,
    'updated_total', updated_count
  );
end;
$$;

revoke all on function public.reconcile_v105_prediction_lifecycle(text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_v105_prediction_lifecycle(text, text, text, integer)
  to service_role;
