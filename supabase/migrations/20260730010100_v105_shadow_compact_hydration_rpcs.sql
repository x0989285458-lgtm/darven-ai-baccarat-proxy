begin;

create or replace function public.get_v105_shadow_v6_compact_history(p_per_table_limit integer)
returns table (
  prediction_id uuid,
  source text,
  table_id text,
  shoe_no text,
  round_no integer,
  strategy_version text,
  prediction_timing text,
  prediction_issued_at timestamptz,
  predicted_result text,
  same_side_streak integer,
  actual_result text,
  settlement_final boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_per_table_limit is null or p_per_table_limit not between 1 and 60 then
    raise exception 'p_per_table_limit must be between 1 and 60' using errcode = '22023';
  end if;

  return query
  with target_tables(target_table_id) as (
    values ('BAG01'), ('BAG02'), ('BAG03'), ('BAG03A'), ('BAG05'),
      ('BAG06'), ('BAG07'), ('BAG08'), ('BAG09'), ('BAG10')
  ),
  compact_rows as (
    select final_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, s.actual_result, true as settlement_final
      from public.v105_shadow_v6_issuances i
      inner join public.v105_shadow_v6_settlements s on s.prediction_id = i.id
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v6-road-pattern'
        and i.prediction_timing = 'pre_result_context'
        and s.settlement_final = true
      order by i.prediction_issued_at desc, i.id desc
      limit p_per_table_limit
    ) final_row
    union all
    select pending_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, null::text as actual_result, false as settlement_final
      from public.v105_shadow_v6_issuances i
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v6-road-pattern'
        and i.prediction_timing = 'pre_result_context'
        and not exists (
          select 1
          from public.v105_shadow_v6_settlements final_settlement
          where final_settlement.prediction_id = i.id
            and final_settlement.settlement_final = true
        )
      order by i.prediction_issued_at desc, i.id desc
      limit 1
    ) pending_row
  )
  select compact.prediction_id, compact.source, compact.table_id, compact.shoe_no, compact.round_no,
    compact.strategy_version, compact.prediction_timing, compact.prediction_issued_at,
    compact.predicted_result, compact.same_side_streak, compact.actual_result, compact.settlement_final
  from compact_rows compact
  order by compact.prediction_issued_at asc, compact.prediction_id asc;
end;
$$;

create or replace function public.get_v105_shadow_v7_compact_history(p_per_table_limit integer)
returns table (
  prediction_id uuid,
  source text,
  table_id text,
  shoe_no text,
  round_no integer,
  strategy_version text,
  prediction_timing text,
  prediction_issued_at timestamptz,
  predicted_result text,
  same_side_streak integer,
  actual_result text,
  settlement_final boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_per_table_limit is null or p_per_table_limit not between 1 and 60 then
    raise exception 'p_per_table_limit must be between 1 and 60' using errcode = '22023';
  end if;

  return query
  with target_tables(target_table_id) as (
    values ('BAG01'), ('BAG02'), ('BAG03'), ('BAG03A'), ('BAG05'),
      ('BAG06'), ('BAG07'), ('BAG08'), ('BAG09'), ('BAG10')
  ),
  compact_rows as (
    select final_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, s.actual_result, true as settlement_final
      from public.v105_shadow_v7_issuances i
      inner join public.v105_shadow_v7_settlements s on s.prediction_id = i.id
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v7-ask-road'
        and i.prediction_timing = 'pre_result_context'
        and s.settlement_final = true
      order by i.prediction_issued_at desc, i.id desc
      limit p_per_table_limit
    ) final_row
    union all
    select pending_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, null::text as actual_result, false as settlement_final
      from public.v105_shadow_v7_issuances i
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v7-ask-road'
        and i.prediction_timing = 'pre_result_context'
        and not exists (
          select 1
          from public.v105_shadow_v7_settlements final_settlement
          where final_settlement.prediction_id = i.id
            and final_settlement.settlement_final = true
        )
      order by i.prediction_issued_at desc, i.id desc
      limit 1
    ) pending_row
  )
  select compact.prediction_id, compact.source, compact.table_id, compact.shoe_no, compact.round_no,
    compact.strategy_version, compact.prediction_timing, compact.prediction_issued_at,
    compact.predicted_result, compact.same_side_streak, compact.actual_result, compact.settlement_final
  from compact_rows compact
  order by compact.prediction_issued_at asc, compact.prediction_id asc;
end;
$$;

create or replace function public.get_v105_shadow_v8_compact_history(p_per_table_limit integer)
returns table (
  prediction_id uuid,
  source text,
  table_id text,
  shoe_no text,
  round_no integer,
  strategy_version text,
  prediction_timing text,
  prediction_issued_at timestamptz,
  predicted_result text,
  same_side_streak integer,
  actual_result text,
  settlement_final boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_per_table_limit is null or p_per_table_limit not between 1 and 60 then
    raise exception 'p_per_table_limit must be between 1 and 60' using errcode = '22023';
  end if;

  return query
  with target_tables(target_table_id) as (
    values ('BAG01'), ('BAG02'), ('BAG03'), ('BAG03A'), ('BAG05'),
      ('BAG06'), ('BAG07'), ('BAG08'), ('BAG09'), ('BAG10')
  ),
  compact_rows as (
    select final_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, s.actual_result, true as settlement_final
      from public.v105_shadow_v8_issuances i
      inner join public.v105_shadow_v8_settlements s on s.prediction_id = i.id
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v8-run-length-ask-road'
        and i.prediction_timing = 'pre_result_context'
        and s.settlement_final = true
      order by i.prediction_issued_at desc, i.id desc
      limit p_per_table_limit
    ) final_row
    union all
    select pending_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, null::text as actual_result, false as settlement_final
      from public.v105_shadow_v8_issuances i
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v8-run-length-ask-road'
        and i.prediction_timing = 'pre_result_context'
        and not exists (
          select 1
          from public.v105_shadow_v8_settlements final_settlement
          where final_settlement.prediction_id = i.id
            and final_settlement.settlement_final = true
        )
      order by i.prediction_issued_at desc, i.id desc
      limit 1
    ) pending_row
  )
  select compact.prediction_id, compact.source, compact.table_id, compact.shoe_no, compact.round_no,
    compact.strategy_version, compact.prediction_timing, compact.prediction_issued_at,
    compact.predicted_result, compact.same_side_streak, compact.actual_result, compact.settlement_final
  from compact_rows compact
  order by compact.prediction_issued_at asc, compact.prediction_id asc;
end;
$$;

create or replace function public.get_v105_shadow_v9_compact_history(p_per_table_limit integer)
returns table (
  prediction_id uuid,
  source text,
  table_id text,
  shoe_no text,
  round_no integer,
  strategy_version text,
  prediction_timing text,
  prediction_issued_at timestamptz,
  predicted_result text,
  same_side_streak integer,
  actual_result text,
  settlement_final boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_per_table_limit is null or p_per_table_limit not between 1 and 60 then
    raise exception 'p_per_table_limit must be between 1 and 60' using errcode = '22023';
  end if;

  return query
  with target_tables(target_table_id) as (
    values ('BAG01'), ('BAG02'), ('BAG03'), ('BAG03A'), ('BAG05'),
      ('BAG06'), ('BAG07'), ('BAG08'), ('BAG09'), ('BAG10')
  ),
  compact_rows as (
    select final_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, s.actual_result, true as settlement_final
      from public.v105_shadow_v9_issuances i
      inner join public.v105_shadow_v9_settlements s on s.prediction_id = i.id
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v9-weighted-v7-v8'
        and i.prediction_timing = 'pre_result_context'
        and s.settlement_final = true
      order by i.prediction_issued_at desc, i.id desc
      limit p_per_table_limit
    ) final_row
    union all
    select pending_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, null::text as actual_result, false as settlement_final
      from public.v105_shadow_v9_issuances i
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v9-weighted-v7-v8'
        and i.prediction_timing = 'pre_result_context'
        and not exists (
          select 1
          from public.v105_shadow_v9_settlements final_settlement
          where final_settlement.prediction_id = i.id
            and final_settlement.settlement_final = true
        )
      order by i.prediction_issued_at desc, i.id desc
      limit 1
    ) pending_row
  )
  select compact.prediction_id, compact.source, compact.table_id, compact.shoe_no, compact.round_no,
    compact.strategy_version, compact.prediction_timing, compact.prediction_issued_at,
    compact.predicted_result, compact.same_side_streak, compact.actual_result, compact.settlement_final
  from compact_rows compact
  order by compact.prediction_issued_at asc, compact.prediction_id asc;
end;
$$;

revoke all on function public.get_v105_shadow_v6_compact_history(integer) from public, anon, authenticated, service_role;
revoke all on function public.get_v105_shadow_v7_compact_history(integer) from public, anon, authenticated, service_role;
revoke all on function public.get_v105_shadow_v8_compact_history(integer) from public, anon, authenticated, service_role;
revoke all on function public.get_v105_shadow_v9_compact_history(integer) from public, anon, authenticated, service_role;
grant execute on function public.get_v105_shadow_v6_compact_history(integer) to service_role;
grant execute on function public.get_v105_shadow_v7_compact_history(integer) to service_role;
grant execute on function public.get_v105_shadow_v8_compact_history(integer) to service_role;
grant execute on function public.get_v105_shadow_v9_compact_history(integer) to service_role;

commit;
