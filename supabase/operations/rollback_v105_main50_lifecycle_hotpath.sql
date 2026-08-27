-- Main50 rollback: restore the exact broad Main49 lifecycle classifier.
-- The Main50 hot index is intentionally preserved as harmless rollback evidence.
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
      and (
        issuance_status is distinct from case
          when shoe_no is distinct from p_current_shoe then 'abandoned_shoe_change'
          when round_no < p_current_visible_round then 'expired_no_final'
          else 'pending'
        end
        or issuance_status_updated_at is null
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
