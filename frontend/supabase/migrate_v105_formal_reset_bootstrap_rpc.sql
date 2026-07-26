create or replace function public.get_v105_recent_performance_rows(p_per_table_limit integer default 60)
returns table (
  id uuid, table_id text, shoe_no text, round_no integer, strategy_version text,
  predicted_result text, actual_result text, is_hit boolean, settlement_final boolean,
  prediction_issued_at timestamptz, created_at timestamptz, prediction_timing text
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.table_id, d.shoe_no, d.round_no, d.strategy_version,
         d.predicted_result, d.actual_result, d.is_hit, d.settlement_final,
         d.prediction_issued_at, d.created_at, d.prediction_timing
  from unnest(array['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10']::text[])
       with ordinality as requested(table_id, table_order)
  cross join lateral (
    select candidate.*
    from (values ('v105'::text), ('v104'::text)) as version(strategy_version)
    cross join lateral (
      select r.id, r.table_id, r.shoe_no, r.round_no, r.strategy_version,
             r.predicted_result, r.actual_result, r.is_hit, true as settlement_final,
             r.prediction_issued_at, r.created_at, 'pre_result_context'::text as prediction_timing
      from public.daily_prediction_results r
      where r.table_id = requested.table_id
        and r.strategy_version = version.strategy_version
        and r.settlement_final is true
        and r.prediction_issued_at is not null
      order by r.created_at desc
      limit least(60, greatest(1, coalesce(p_per_table_limit, 60)))
    ) candidate
    order by candidate.created_at desc
    limit least(60, greatest(1, coalesce(p_per_table_limit, 60)))
  ) d
  order by requested.table_order, d.created_at desc;
$$;

revoke all on function public.get_v105_recent_performance_rows(integer) from public;
revoke all on function public.get_v105_recent_performance_rows(integer) from anon;
revoke all on function public.get_v105_recent_performance_rows(integer) from authenticated;
grant execute on function public.get_v105_recent_performance_rows(integer) to service_role;
