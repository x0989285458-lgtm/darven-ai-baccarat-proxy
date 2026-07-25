
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
  select id, table_id, shoe_no, round_no, strategy_version, predicted_result, actual_result,
         is_hit, settlement_final, prediction_issued_at, created_at, prediction_timing
  from (
    (select 1 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG01'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 2 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG02'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 3 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG03'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 4 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG03A'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 5 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG05'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 6 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG06'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 7 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG07'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 8 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG08'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 9 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG09'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 10 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG10'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
  ) recent
  order by table_order, created_at desc;
$$;

revoke all on function public.get_v105_recent_performance_rows(integer) from public;
revoke all on function public.get_v105_recent_performance_rows(integer) from anon;
revoke all on function public.get_v105_recent_performance_rows(integer) from authenticated;
grant execute on function public.get_v105_recent_performance_rows(integer) to service_role;
