-- LOCAL CANDIDATE ONLY. NOT EXECUTED. NOT DEPLOYMENT AUTHORITY.
-- See db-six-raw-plan.json: local-only; true PG validation and settlement caller readback remain pending.
-- Quiesce writers before any separately authorized application. No cleanup or row rewrite.
-- source='ofalive99' is the observed Proxy storage namespace, NOT a claim of provider identity.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
BEGIN
  IF pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_v105_recent_performance_rows(integer)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.get_v105_recent_performance_rows(p_per_table_limit integer DEFAULT 60)
 RETURNS TABLE(id uuid, table_id text, shoe_no text, round_no integer, strategy_version text, predicted_result text, actual_result text, is_hit boolean, settlement_final boolean, prediction_issued_at timestamp with time zone, created_at timestamp with time zone, prediction_timing text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
             r.prediction_issued_at, r.created_at,
             coalesce(
               r.prediction_features->>'prediction_timing',
               r.issued_prediction_payload->>'predictionTiming'
             ) as prediction_timing
      from public.daily_prediction_results r
      where r.table_id = requested.table_id
        and r.strategy_version = version.strategy_version
        and r.settlement_final is true
        and r.prediction_issued_at is not null
        and coalesce(
          r.prediction_features->>'prediction_timing',
          r.issued_prediction_payload->>'predictionTiming'
        ) = 'pre_result_context'
      order by r.created_at desc
      limit least(60, greatest(1, coalesce(p_per_table_limit, 60)))
    ) candidate
    order by candidate.created_at desc
    limit least(60, greatest(1, coalesce(p_per_table_limit, 60)))
  ) d
  order by requested.table_order, d.created_at desc;
$function$
$expected$ THEN
    RAISE EXCEPTION 'six-raw definition drift: get_v105_recent_performance_rows';
  END IF;
  IF pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.v105_accumulate_daily_settlement(text, text, text, text, integer, timestamp with time zone, text, text, boolean, boolean, jsonb, jsonb)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.v105_accumulate_daily_settlement(p_source text, p_strategy_version text, p_table_id text, p_shoe_no text, p_round_no integer, p_created_at timestamp with time zone, p_predicted_result text, p_actual_result text, p_is_hit boolean, p_settlement_final boolean, p_prediction_features jsonb, p_side_hits jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  event_date date := timezone('Asia/Taipei', p_created_at)::date;
  actions jsonb := coalesce(p_prediction_features->'side_actions', '{}'::jsonb);
  hits jsonb := coalesce(p_side_hits, p_prediction_features->'side_hits', '{}'::jsonb);
  side_contract boolean := false;
  inserted_count integer := 0;
  v_main_total integer := 0;
  v_main_hits integer := 0;
  v_banker_total integer := 0;
  v_banker_hits integer := 0;
  v_player_total integer := 0;
  v_player_hits integer := 0;
  v_side_actions integer := 0;
  v_side_hits integer := 0;
  v_tie_total integer := 0;
  v_tie_hits integer := 0;
  v_dragon_total integer := 0;
  v_dragon_hits integer := 0;
  v_pair_total integer := 0;
  v_pair_hits integer := 0;
  v_six_total integer := 0;
  v_six_hits integer := 0;
begin
  if p_source is distinct from 'ofalive99'
    or p_strategy_version is distinct from 'v105'
    or p_table_id <> all(array['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10'])
    or p_settlement_final is not true then
    return;
  end if;

  v_main_total := case when p_predicted_result in ('banker', 'player') and p_actual_result in ('banker', 'player') then 1 else 0 end;
  v_main_hits := case when v_main_total = 1 and p_is_hit is true then 1 else 0 end;
  v_banker_total := case when p_predicted_result = 'banker' and p_actual_result in ('banker', 'player') then 1 else 0 end;
  v_banker_hits := case when v_banker_total = 1 and p_actual_result = 'banker' then 1 else 0 end;
  v_player_total := case when p_predicted_result = 'player' and p_actual_result in ('banker', 'player') then 1 else 0 end;
  v_player_hits := case when v_player_total = 1 and p_actual_result = 'player' then 1 else 0 end;

  if jsonb_typeof(actions) = 'object' and jsonb_typeof(hits) = 'object' then
    select count(*) = 6 into side_contract from jsonb_object_keys(actions);
    side_contract := side_contract
      and actions ?& array['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
      and hits ?& array['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
      and (select count(*) from jsonb_object_keys(hits)) = 6
      and actions->>'tie' in ('true','false') and actions->>'superSix' in ('true','false')
      and actions->>'bankerPair' in ('true','false') and actions->>'playerPair' in ('true','false')
      and actions->>'bankerDragon' in ('true','false') and actions->>'playerDragon' in ('true','false')
      and hits->>'tie' in ('true','false') and hits->>'superSix' in ('true','false')
      and hits->>'bankerPair' in ('true','false') and hits->>'playerPair' in ('true','false')
      and hits->>'bankerDragon' in ('true','false') and hits->>'playerDragon' in ('true','false');
  end if;

  if side_contract then
    v_tie_total := (actions->>'tie')::boolean::integer;
    v_tie_hits := ((actions->>'tie')::boolean and (hits->>'tie')::boolean)::integer;
    v_six_total := (actions->>'superSix')::boolean::integer;
    v_six_hits := ((actions->>'superSix')::boolean and (hits->>'superSix')::boolean)::integer;
    v_pair_total := (actions->>'bankerPair')::boolean::integer + (actions->>'playerPair')::boolean::integer;
    v_pair_hits := ((actions->>'bankerPair')::boolean and (hits->>'bankerPair')::boolean)::integer
      + ((actions->>'playerPair')::boolean and (hits->>'playerPair')::boolean)::integer;
    v_dragon_total := case
      when p_predicted_result = 'banker' then (actions->>'bankerDragon')::boolean::integer
      when p_predicted_result = 'player' then (actions->>'playerDragon')::boolean::integer
      else 0 end;
    v_dragon_hits := case
      when p_predicted_result = 'banker' then ((actions->>'bankerDragon')::boolean and (hits->>'bankerDragon')::boolean)::integer
      when p_predicted_result = 'player' then ((actions->>'playerDragon')::boolean and (hits->>'playerDragon')::boolean)::integer
      else 0 end;
    v_side_actions := v_tie_total + v_six_total + v_pair_total
      + (actions->>'bankerDragon')::boolean::integer + (actions->>'playerDragon')::boolean::integer;
    v_side_hits := v_tie_hits + v_six_hits + v_pair_hits
      + ((actions->>'bankerDragon')::boolean and (hits->>'bankerDragon')::boolean)::integer
      + ((actions->>'playerDragon')::boolean and (hits->>'playerDragon')::boolean)::integer;
  end if;

  insert into public.v105_daily_settlement_events (
    source, strategy_version, table_id, shoe_no, round_no, analytics_date,
    main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
    side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
    dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  ) values (
    p_source, p_strategy_version, p_table_id, p_shoe_no, p_round_no, event_date,
    v_main_total, v_main_hits, v_banker_total, v_banker_hits, v_player_total, v_player_hits,
    side_contract::integer, v_side_actions, v_side_hits, v_tie_total, v_tie_hits,
    v_dragon_total, v_dragon_hits, v_pair_total, v_pair_hits, v_six_total, v_six_hits
  ) on conflict (source, strategy_version, table_id, shoe_no, round_no) do nothing;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    return;
  end if;

  insert into public.v105_daily_settlement_analytics (
    analytics_date, strategy_version, table_id, rounds,
    main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
    side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
    dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  ) values (
    event_date, p_strategy_version, p_table_id, 1,
    v_main_total, v_main_hits, v_banker_total, v_banker_hits, v_player_total, v_player_hits,
    side_contract::integer, v_side_actions, v_side_hits, v_tie_total, v_tie_hits,
    v_dragon_total, v_dragon_hits, v_pair_total, v_pair_hits, v_six_total, v_six_hits
  ) on conflict (analytics_date, strategy_version, table_id) do update set
    rounds = v105_daily_settlement_analytics.rounds + excluded.rounds,
    main_total = v105_daily_settlement_analytics.main_total + excluded.main_total,
    main_hits = v105_daily_settlement_analytics.main_hits + excluded.main_hits,
    banker_total = v105_daily_settlement_analytics.banker_total + excluded.banker_total,
    banker_hits = v105_daily_settlement_analytics.banker_hits + excluded.banker_hits,
    player_total = v105_daily_settlement_analytics.player_total + excluded.player_total,
    player_hits = v105_daily_settlement_analytics.player_hits + excluded.player_hits,
    side_contract_rows = v105_daily_settlement_analytics.side_contract_rows + excluded.side_contract_rows,
    side_actions = v105_daily_settlement_analytics.side_actions + excluded.side_actions,
    side_hits = v105_daily_settlement_analytics.side_hits + excluded.side_hits,
    tie_total = v105_daily_settlement_analytics.tie_total + excluded.tie_total,
    tie_hits = v105_daily_settlement_analytics.tie_hits + excluded.tie_hits,
    dragon_total = v105_daily_settlement_analytics.dragon_total + excluded.dragon_total,
    dragon_hits = v105_daily_settlement_analytics.dragon_hits + excluded.dragon_hits,
    pair_total = v105_daily_settlement_analytics.pair_total + excluded.pair_total,
    pair_hits = v105_daily_settlement_analytics.pair_hits + excluded.pair_hits,
    six_total = v105_daily_settlement_analytics.six_total + excluded.six_total,
    six_hits = v105_daily_settlement_analytics.six_hits + excluded.six_hits,
    updated_at = now();
end;
$function$
$expected$ THEN
    RAISE EXCEPTION 'six-raw definition drift: v105_accumulate_daily_settlement';
  END IF;
  IF pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.v105_backfill_daily_settlements(integer)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.v105_backfill_daily_settlements(p_limit integer DEFAULT 25)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with candidates as materialized (
    select distinct on (d.source, d.strategy_version, d.table_id, d.shoe_no, d.round_no)
      d.source, d.strategy_version, d.table_id, d.shoe_no, d.round_no, d.created_at,
      d.predicted_result, d.actual_result, d.is_hit
    from public.daily_prediction_results d
    where d.created_at >= (timezone('Asia/Taipei', now())::date::timestamp at time zone 'Asia/Taipei')
      and d.created_at < ((timezone('Asia/Taipei', now())::date + 1)::timestamp at time zone 'Asia/Taipei')
      and d.source = 'ofalive99'
      and d.strategy_version = 'v105'
      and d.table_id = any(array['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10'])
      and d.settlement_final is true
      and not exists (
        select 1 from public.v105_daily_settlement_events e
        where e.source = d.source and e.strategy_version = d.strategy_version and e.table_id = d.table_id
          and e.shoe_no = d.shoe_no and e.round_no = d.round_no
      )
    order by d.source, d.strategy_version, d.table_id, d.shoe_no, d.round_no, d.created_at
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), payloads as (
    select c.*,
      coalesce(d.prediction_features->'side_actions', '{}'::jsonb) as actions,
      coalesce(d.side_hits, d.prediction_features->'side_hits', '{}'::jsonb) as hits
    from candidates c
    join public.daily_prediction_results d
      on d.source = c.source and d.strategy_version = c.strategy_version and d.table_id = c.table_id
      and d.shoe_no = c.shoe_no and d.round_no = c.round_no
  ), validated as (
    select c.*,
      case when jsonb_typeof(c.actions) = 'object' and jsonb_typeof(c.hits) = 'object' then
        (select count(*) from jsonb_object_keys(c.actions)) = 6
        and c.actions ?& array['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
        and c.hits ?& array['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
        and (select count(*) from jsonb_object_keys(c.hits)) = 6
        and c.actions->>'tie' in ('true','false') and c.actions->>'superSix' in ('true','false')
        and c.actions->>'bankerPair' in ('true','false') and c.actions->>'playerPair' in ('true','false')
        and c.actions->>'bankerDragon' in ('true','false') and c.actions->>'playerDragon' in ('true','false')
        and c.hits->>'tie' in ('true','false') and c.hits->>'superSix' in ('true','false')
        and c.hits->>'bankerPair' in ('true','false') and c.hits->>'playerPair' in ('true','false')
        and c.hits->>'bankerDragon' in ('true','false') and c.hits->>'playerDragon' in ('true','false')
      else false end as side_contract
    from payloads c
  ), metrics as (
    select
      v.source, v.strategy_version, v.table_id, v.shoe_no, v.round_no,
      timezone('Asia/Taipei', v.created_at)::date as analytics_date,
      case when v.predicted_result in ('banker', 'player') and v.actual_result in ('banker', 'player') then 1 else 0 end as main_total,
      case when v.predicted_result in ('banker', 'player') and v.actual_result in ('banker', 'player') and v.is_hit is true then 1 else 0 end as main_hits,
      case when v.predicted_result = 'banker' and v.actual_result in ('banker', 'player') then 1 else 0 end as banker_total,
      case when v.predicted_result = 'banker' and v.actual_result = 'banker' then 1 else 0 end as banker_hits,
      case when v.predicted_result = 'player' and v.actual_result in ('banker', 'player') then 1 else 0 end as player_total,
      case when v.predicted_result = 'player' and v.actual_result = 'player' then 1 else 0 end as player_hits,
      v.side_contract::integer as side_contract_rows,
      case when v.side_contract then
        (v.actions->>'tie')::boolean::integer
        + (v.actions->>'superSix')::boolean::integer
        + (v.actions->>'bankerPair')::boolean::integer
        + (v.actions->>'playerPair')::boolean::integer
        + (v.actions->>'bankerDragon')::boolean::integer
        + (v.actions->>'playerDragon')::boolean::integer
      else 0 end as side_actions,
      case when v.side_contract then
        ((v.actions->>'tie')::boolean and (v.hits->>'tie')::boolean)::integer
        + ((v.actions->>'superSix')::boolean and (v.hits->>'superSix')::boolean)::integer
        + ((v.actions->>'bankerPair')::boolean and (v.hits->>'bankerPair')::boolean)::integer
        + ((v.actions->>'playerPair')::boolean and (v.hits->>'playerPair')::boolean)::integer
        + ((v.actions->>'bankerDragon')::boolean and (v.hits->>'bankerDragon')::boolean)::integer
        + ((v.actions->>'playerDragon')::boolean and (v.hits->>'playerDragon')::boolean)::integer
      else 0 end as side_hits,
      case when v.side_contract then (v.actions->>'tie')::boolean::integer else 0 end as tie_total,
      case when v.side_contract then ((v.actions->>'tie')::boolean and (v.hits->>'tie')::boolean)::integer else 0 end as tie_hits,
      case when v.side_contract and v.predicted_result = 'banker' then (v.actions->>'bankerDragon')::boolean::integer
        when v.side_contract and v.predicted_result = 'player' then (v.actions->>'playerDragon')::boolean::integer
        else 0 end as dragon_total,
      case when v.side_contract and v.predicted_result = 'banker' then ((v.actions->>'bankerDragon')::boolean and (v.hits->>'bankerDragon')::boolean)::integer
        when v.side_contract and v.predicted_result = 'player' then ((v.actions->>'playerDragon')::boolean and (v.hits->>'playerDragon')::boolean)::integer
        else 0 end as dragon_hits,
      case when v.side_contract then
        (v.actions->>'bankerPair')::boolean::integer + (v.actions->>'playerPair')::boolean::integer
      else 0 end as pair_total,
      case when v.side_contract then
        ((v.actions->>'bankerPair')::boolean and (v.hits->>'bankerPair')::boolean)::integer
        + ((v.actions->>'playerPair')::boolean and (v.hits->>'playerPair')::boolean)::integer
      else 0 end as pair_hits,
      case when v.side_contract then (v.actions->>'superSix')::boolean::integer else 0 end as six_total,
      case when v.side_contract then ((v.actions->>'superSix')::boolean and (v.hits->>'superSix')::boolean)::integer else 0 end as six_hits
    from validated v
  ), inserted_events as (
    insert into public.v105_daily_settlement_events (
      source, strategy_version, table_id, shoe_no, round_no, analytics_date,
      main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
      side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
      dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
    )
    select
      source, strategy_version, table_id, shoe_no, round_no, analytics_date,
      main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
      side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
      dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
    from metrics
    on conflict (source, strategy_version, table_id, shoe_no, round_no) do nothing
    returning analytics_date, strategy_version, table_id,
      main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
      side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
      dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  ), aggregated as (
    select analytics_date, strategy_version, table_id, count(*)::integer as rounds,
      sum(main_total)::integer as main_total, sum(main_hits)::integer as main_hits,
      sum(banker_total)::integer as banker_total, sum(banker_hits)::integer as banker_hits,
      sum(player_total)::integer as player_total, sum(player_hits)::integer as player_hits,
      sum(side_contract_rows)::integer as side_contract_rows,
      sum(side_actions)::integer as side_actions, sum(side_hits)::integer as side_hits,
      sum(tie_total)::integer as tie_total, sum(tie_hits)::integer as tie_hits,
      sum(dragon_total)::integer as dragon_total, sum(dragon_hits)::integer as dragon_hits,
      sum(pair_total)::integer as pair_total, sum(pair_hits)::integer as pair_hits,
      sum(six_total)::integer as six_total, sum(six_hits)::integer as six_hits
    from inserted_events
    group by analytics_date, strategy_version, table_id
  )
  insert into public.v105_daily_settlement_analytics (
    analytics_date, strategy_version, table_id, rounds,
    main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
    side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
    dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  )
  select analytics_date, strategy_version, table_id, rounds,
    main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
    side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
    dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  from aggregated
  on conflict (analytics_date, strategy_version, table_id) do update set
    rounds = v105_daily_settlement_analytics.rounds + excluded.rounds,
    main_total = v105_daily_settlement_analytics.main_total + excluded.main_total,
    main_hits = v105_daily_settlement_analytics.main_hits + excluded.main_hits,
    banker_total = v105_daily_settlement_analytics.banker_total + excluded.banker_total,
    banker_hits = v105_daily_settlement_analytics.banker_hits + excluded.banker_hits,
    player_total = v105_daily_settlement_analytics.player_total + excluded.player_total,
    player_hits = v105_daily_settlement_analytics.player_hits + excluded.player_hits,
    side_contract_rows = v105_daily_settlement_analytics.side_contract_rows + excluded.side_contract_rows,
    side_actions = v105_daily_settlement_analytics.side_actions + excluded.side_actions,
    side_hits = v105_daily_settlement_analytics.side_hits + excluded.side_hits,
    tie_total = v105_daily_settlement_analytics.tie_total + excluded.tie_total,
    tie_hits = v105_daily_settlement_analytics.tie_hits + excluded.tie_hits,
    dragon_total = v105_daily_settlement_analytics.dragon_total + excluded.dragon_total,
    dragon_hits = v105_daily_settlement_analytics.dragon_hits + excluded.dragon_hits,
    pair_total = v105_daily_settlement_analytics.pair_total + excluded.pair_total,
    pair_hits = v105_daily_settlement_analytics.pair_hits + excluded.pair_hits,
    six_total = v105_daily_settlement_analytics.six_total + excluded.six_total,
    six_hits = v105_daily_settlement_analytics.six_hits + excluded.six_hits,
    updated_at = now();
$function$
$expected$ THEN
    RAISE EXCEPTION 'six-raw definition drift: v105_backfill_daily_settlements';
  END IF;
  IF pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.rebuild_v100_rank_ledger_from_cloud_rounds(text, text, text)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.rebuild_v100_rank_ledger_from_cloud_rounds(p_source text, p_table_id text, p_shoe_no text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  latest_shoe text;
  min_round integer;
  max_round integer;
  row_count integer;
  distinct_round_count integer;
  round_row record;
  apply_result jsonb;
  final_ledger public.shoe_rank_ledgers%rowtype;
begin
  if nullif(p_source,'') is null or nullif(p_table_id,'') is null or nullif(p_shoe_no,'') is null
     or p_table_id not in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10') then
    raise exception 'invalid v100 rank recovery identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v100-rank|'||p_source||'|'||p_table_id||'|'||p_shoe_no,0)
  );

  select shoe_no into latest_shoe
  from public.cloud_table_rounds
  where source=p_source and table_id=p_table_id
  order by received_at desc,round_no desc
  limit 1;
  if latest_shoe is distinct from p_shoe_no then
    raise exception 'v100 rank recovery accepts only the current authoritative shoe';
  end if;

  select min(round_no),max(round_no),count(*)::integer,count(distinct round_no)::integer
    into min_round,max_round,row_count,distinct_round_count
  from public.cloud_table_rounds
  where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no;
  if min_round is distinct from 1 or max_round is null
     or row_count is distinct from max_round or distinct_round_count is distinct from max_round then
    raise exception 'v100 rank recovery authoritative shoe is incomplete';
  end if;

  for round_row in
    select round_no,raw_event
    from public.cloud_table_rounds
    where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no
    order by round_no
    for share
  loop
    apply_result:=public.apply_v100_rank_ledger_event(jsonb_build_object(
      'source',p_source,
      'table_id',p_table_id,
      'shoe_no',p_shoe_no,
      'round_no',round_row.round_no,
      'source_action',round_row.raw_event->>'sourceAction',
      'raw_result_exact10',round_row.raw_event->'rawResult'
    ));
    if apply_result->'accepted' is distinct from 'true'::jsonb
       or apply_result->>'status' is distinct from 'contiguous' then
      raise exception 'v100 rank recovery rejected round %',round_row.round_no;
    end if;
  end loop;

  select * into final_ledger
  from public.shoe_rank_ledgers
  where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no
  for share;
  if final_ledger.status is distinct from 'contiguous'
     or final_ledger.complete_through_round is distinct from max_round then
    raise exception 'v100 rank recovery did not reach the authoritative Final';
  end if;

  return jsonb_build_object(
    'accepted',true,
    'source',p_source,
    'table_id',p_table_id,
    'shoe_no',p_shoe_no,
    'complete_through_round',max_round,
    'status',final_ledger.status,
    'remaining_rank_counts',final_ledger.undealt_after_observed_deals
  );
end;
$function$
$expected$ THEN
    RAISE EXCEPTION 'six-raw definition drift: rebuild_v100_rank_ledger_from_cloud_rounds';
  END IF;
  IF pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.backfill_v105_formal_compact_batch(text, timestamp with time zone, uuid, integer)')) IS DISTINCT FROM $expected$CREATE OR REPLACE FUNCTION public.backfill_v105_formal_compact_batch(p_table_id text, p_after_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  candidate record;
  processed integer := 0;
  inserted integer := 0;
  last_created_at timestamptz := p_after_created_at;
  last_id uuid := p_after_id;
begin
  if p_table_id not in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')
     or p_limit not between 1 and 250
     or (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'invalid v105 formal compact backfill cursor';
  end if;

  for candidate in
    select id, created_at
    from public.daily_prediction_results
    where strategy_version = 'v105'
      and table_id = p_table_id
      and settlement_final is true
      and prediction_issued_at is not null
      and resolved_at >= prediction_issued_at
      and (
        p_after_created_at is null
        or created_at > p_after_created_at
        or (created_at = p_after_created_at and id > p_after_id)
      )
    order by created_at, id
    limit p_limit
  loop
    processed := processed + 1;
    if public.capture_v105_formal_compact_settlement(candidate.id) then inserted := inserted + 1; end if;
    last_created_at := candidate.created_at;
    last_id := candidate.id;
  end loop;

  return jsonb_build_object(
    'table_id', p_table_id,
    'processed', processed,
    'inserted', inserted,
    'done', processed < p_limit,
    'next_created_at', last_created_at,
    'next_id', last_id
  );
end;
$function$
$expected$ THEN
    RAISE EXCEPTION 'six-raw definition drift: backfill_v105_formal_compact_batch';
  END IF;
END;
$guard$;

DO $raw_catalog_guard$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='apply_v100_rank_ledger_event' AND pg_catalog.pg_get_function_identity_arguments(p.oid)='p_event jsonb, p_ledger jsonb' AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))='40e581211866ab88c6c55e4bdc66cc8b') <> 1 THEN RAISE EXCEPTION 'six-raw dependency drift: apply_v100_rank_ledger_event'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='preserve_cloud_round_first_received_at' AND pg_catalog.pg_get_function_identity_arguments(p.oid)='' AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))='aa5e9c2f3e34f8645fbba7f0c979d6e6') <> 1 THEN RAISE EXCEPTION 'six-raw dependency drift: preserve_cloud_round_first_received_at'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='verify_v105_formal_compact_counters' AND pg_catalog.pg_get_function_identity_arguments(p.oid)='' AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))='2f0a58ad2438afd62e6c36ffe5b018d7') <> 1 THEN RAISE EXCEPTION 'six-raw dependency drift: verify_v105_formal_compact_counters'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='capture_v105_formal_compact_settlement' AND pg_catalog.pg_get_function_identity_arguments(p.oid)='p_prediction_id uuid' AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))='7a95886b29b52b0ba19804b2e24e3d4f') <> 1 THEN RAISE EXCEPTION 'six-raw dependency drift: capture_v105_formal_compact_settlement'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='sync_v105_formal_compact_settlement' AND pg_catalog.pg_get_function_identity_arguments(p.oid)='' AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))='a064a025aa17301487a33ba09e115881') <> 1 THEN RAISE EXCEPTION 'six-raw dependency drift: sync_v105_formal_compact_settlement'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid='public.daily_prediction_results'::regclass AND tgname='sync_v105_formal_compact_settlement' AND tgenabled='D' AND NOT tgisinternal) <> 1 THEN RAISE EXCEPTION 'six-raw compact trigger must remain disabled'; END IF;
END;
$raw_catalog_guard$;

LOCK TABLE public.v105_formal_compact_settlements IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid = 'public.v105_formal_compact_settlements'::regclass AND conname = 'v105_formal_compact_settlements_table_id_check' AND contype = 'c' AND convalidated AND pg_catalog.pg_get_constraintdef(oid) = $check$CHECK ((table_id = ANY (ARRAY['BAG01'::text, 'BAG02'::text, 'BAG03'::text, 'BAG03A'::text, 'BAG05'::text, 'BAG06'::text, 'BAG07'::text, 'BAG08'::text, 'BAG09'::text, 'BAG10'::text])))$check$) <> 1 THEN
    RAISE EXCEPTION 'six-raw original CHECK/schema/validation drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.v105_formal_compact_settlements'::regclass AND conname = 'v105_formal_compact_settlements_table_id_six_raw_check') THEN
    RAISE EXCEPTION 'six-raw additive CHECK already exists; reconcile instead of replay';
  END IF;
END;
$guard$;

-- Widen the legal domain additively: retain ALL ten BAG IDs plus six literal raw IDs.
-- A second broad CHECK alone cannot override the old restrictive CHECK (checks are ANDed).
-- Validate replacement BEFORE removing predecessor, in this same transaction.
ALTER TABLE public.v105_formal_compact_settlements ADD CONSTRAINT v105_formal_compact_settlements_table_id_six_raw_check CHECK ((table_id = ANY (ARRAY['BAG01'::text, 'BAG02'::text, 'BAG03'::text, 'BAG03A'::text, 'BAG05'::text, 'BAG06'::text, 'BAG07'::text, 'BAG08'::text, 'BAG09'::text, 'BAG10'::text, 'BAV01'::text, 'BAV02'::text, 'BAV03'::text, 'BAV03A'::text, 'BAV05'::text, 'BAV06'::text]))) NOT VALID;
ALTER TABLE public.v105_formal_compact_settlements VALIDATE CONSTRAINT v105_formal_compact_settlements_table_id_six_raw_check;
ALTER TABLE public.v105_formal_compact_settlements DROP CONSTRAINT v105_formal_compact_settlements_table_id_check;

-- Minimal exact-definition delta: get_v105_recent_performance_rows
CREATE OR REPLACE FUNCTION public.get_v105_recent_performance_rows(p_per_table_limit integer DEFAULT 60)
 RETURNS TABLE(id uuid, table_id text, shoe_no text, round_no integer, strategy_version text, predicted_result text, actual_result text, is_hit boolean, settlement_final boolean, prediction_issued_at timestamp with time zone, created_at timestamp with time zone, prediction_timing text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select d.id, d.table_id, d.shoe_no, d.round_no, d.strategy_version,
         d.predicted_result, d.actual_result, d.is_hit, d.settlement_final,
         d.prediction_issued_at, d.created_at, d.prediction_timing
  from unnest(array['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']::text[])
       with ordinality as requested(table_id, table_order)
  cross join lateral (
    select candidate.*
    from (values ('v105'::text)) as version(strategy_version)
    cross join lateral (
      select r.id, r.table_id, r.shoe_no, r.round_no, r.strategy_version,
             r.predicted_result, r.actual_result, r.is_hit, true as settlement_final,
             r.prediction_issued_at, r.created_at,
             coalesce(
               r.prediction_features->>'prediction_timing',
               r.issued_prediction_payload->>'predictionTiming'
             ) as prediction_timing
      from public.daily_prediction_results r
      where r.table_id = requested.table_id
        and r.source = 'ofalive99'
        and r.strategy_version = version.strategy_version
        and r.settlement_final is true
        and r.prediction_issued_at is not null
        and coalesce(
          r.prediction_features->>'prediction_timing',
          r.issued_prediction_payload->>'predictionTiming'
        ) = 'pre_result_context'
      order by r.created_at desc
      limit least(60, greatest(1, coalesce(p_per_table_limit, 60)))
    ) candidate
    order by candidate.created_at desc
    limit least(60, greatest(1, coalesce(p_per_table_limit, 60)))
  ) d
  order by requested.table_order, d.created_at desc;
$function$
;

-- Minimal exact-definition delta: v105_accumulate_daily_settlement
CREATE OR REPLACE FUNCTION public.v105_accumulate_daily_settlement(p_source text, p_strategy_version text, p_table_id text, p_shoe_no text, p_round_no integer, p_created_at timestamp with time zone, p_predicted_result text, p_actual_result text, p_is_hit boolean, p_settlement_final boolean, p_prediction_features jsonb, p_side_hits jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  event_date date := timezone('Asia/Taipei', p_created_at)::date;
  actions jsonb := coalesce(p_prediction_features->'side_actions', '{}'::jsonb);
  hits jsonb := coalesce(p_side_hits, p_prediction_features->'side_hits', '{}'::jsonb);
  side_contract boolean := false;
  inserted_count integer := 0;
  v_main_total integer := 0;
  v_main_hits integer := 0;
  v_banker_total integer := 0;
  v_banker_hits integer := 0;
  v_player_total integer := 0;
  v_player_hits integer := 0;
  v_side_actions integer := 0;
  v_side_hits integer := 0;
  v_tie_total integer := 0;
  v_tie_hits integer := 0;
  v_dragon_total integer := 0;
  v_dragon_hits integer := 0;
  v_pair_total integer := 0;
  v_pair_hits integer := 0;
  v_six_total integer := 0;
  v_six_hits integer := 0;
begin
  if p_source is distinct from 'ofalive99'
    or p_strategy_version is distinct from 'v105'
    or p_table_id is null
    or p_table_id <> all(array['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10','BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06'])
    or p_settlement_final is not true then
    return;
  end if;

  v_main_total := case when p_predicted_result in ('banker', 'player') and p_actual_result in ('banker', 'player') then 1 else 0 end;
  v_main_hits := case when v_main_total = 1 and p_is_hit is true then 1 else 0 end;
  v_banker_total := case when p_predicted_result = 'banker' and p_actual_result in ('banker', 'player') then 1 else 0 end;
  v_banker_hits := case when v_banker_total = 1 and p_actual_result = 'banker' then 1 else 0 end;
  v_player_total := case when p_predicted_result = 'player' and p_actual_result in ('banker', 'player') then 1 else 0 end;
  v_player_hits := case when v_player_total = 1 and p_actual_result = 'player' then 1 else 0 end;

  if jsonb_typeof(actions) = 'object' and jsonb_typeof(hits) = 'object' then
    select count(*) = 6 into side_contract from jsonb_object_keys(actions);
    side_contract := side_contract
      and actions ?& array['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
      and hits ?& array['tie','superSix','bankerPair','playerPair','bankerDragon','playerDragon']
      and (select count(*) from jsonb_object_keys(hits)) = 6
      and actions->>'tie' in ('true','false') and actions->>'superSix' in ('true','false')
      and actions->>'bankerPair' in ('true','false') and actions->>'playerPair' in ('true','false')
      and actions->>'bankerDragon' in ('true','false') and actions->>'playerDragon' in ('true','false')
      and hits->>'tie' in ('true','false') and hits->>'superSix' in ('true','false')
      and hits->>'bankerPair' in ('true','false') and hits->>'playerPair' in ('true','false')
      and hits->>'bankerDragon' in ('true','false') and hits->>'playerDragon' in ('true','false');
  end if;

  if side_contract then
    v_tie_total := (actions->>'tie')::boolean::integer;
    v_tie_hits := ((actions->>'tie')::boolean and (hits->>'tie')::boolean)::integer;
    v_six_total := (actions->>'superSix')::boolean::integer;
    v_six_hits := ((actions->>'superSix')::boolean and (hits->>'superSix')::boolean)::integer;
    v_pair_total := (actions->>'bankerPair')::boolean::integer + (actions->>'playerPair')::boolean::integer;
    v_pair_hits := ((actions->>'bankerPair')::boolean and (hits->>'bankerPair')::boolean)::integer
      + ((actions->>'playerPair')::boolean and (hits->>'playerPair')::boolean)::integer;
    v_dragon_total := case
      when p_predicted_result = 'banker' then (actions->>'bankerDragon')::boolean::integer
      when p_predicted_result = 'player' then (actions->>'playerDragon')::boolean::integer
      else 0 end;
    v_dragon_hits := case
      when p_predicted_result = 'banker' then ((actions->>'bankerDragon')::boolean and (hits->>'bankerDragon')::boolean)::integer
      when p_predicted_result = 'player' then ((actions->>'playerDragon')::boolean and (hits->>'playerDragon')::boolean)::integer
      else 0 end;
    v_side_actions := v_tie_total + v_six_total + v_pair_total
      + (actions->>'bankerDragon')::boolean::integer + (actions->>'playerDragon')::boolean::integer;
    v_side_hits := v_tie_hits + v_six_hits + v_pair_hits
      + ((actions->>'bankerDragon')::boolean and (hits->>'bankerDragon')::boolean)::integer
      + ((actions->>'playerDragon')::boolean and (hits->>'playerDragon')::boolean)::integer;
  end if;

  insert into public.v105_daily_settlement_events (
    source, strategy_version, table_id, shoe_no, round_no, analytics_date,
    main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
    side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
    dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  ) values (
    p_source, p_strategy_version, p_table_id, p_shoe_no, p_round_no, event_date,
    v_main_total, v_main_hits, v_banker_total, v_banker_hits, v_player_total, v_player_hits,
    side_contract::integer, v_side_actions, v_side_hits, v_tie_total, v_tie_hits,
    v_dragon_total, v_dragon_hits, v_pair_total, v_pair_hits, v_six_total, v_six_hits
  ) on conflict (source, strategy_version, table_id, shoe_no, round_no) do nothing;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    return;
  end if;

  insert into public.v105_daily_settlement_analytics (
    analytics_date, strategy_version, table_id, rounds,
    main_total, main_hits, banker_total, banker_hits, player_total, player_hits,
    side_contract_rows, side_actions, side_hits, tie_total, tie_hits,
    dragon_total, dragon_hits, pair_total, pair_hits, six_total, six_hits
  ) values (
    event_date, p_strategy_version, p_table_id, 1,
    v_main_total, v_main_hits, v_banker_total, v_banker_hits, v_player_total, v_player_hits,
    side_contract::integer, v_side_actions, v_side_hits, v_tie_total, v_tie_hits,
    v_dragon_total, v_dragon_hits, v_pair_total, v_pair_hits, v_six_total, v_six_hits
  ) on conflict (analytics_date, strategy_version, table_id) do update set
    rounds = v105_daily_settlement_analytics.rounds + excluded.rounds,
    main_total = v105_daily_settlement_analytics.main_total + excluded.main_total,
    main_hits = v105_daily_settlement_analytics.main_hits + excluded.main_hits,
    banker_total = v105_daily_settlement_analytics.banker_total + excluded.banker_total,
    banker_hits = v105_daily_settlement_analytics.banker_hits + excluded.banker_hits,
    player_total = v105_daily_settlement_analytics.player_total + excluded.player_total,
    player_hits = v105_daily_settlement_analytics.player_hits + excluded.player_hits,
    side_contract_rows = v105_daily_settlement_analytics.side_contract_rows + excluded.side_contract_rows,
    side_actions = v105_daily_settlement_analytics.side_actions + excluded.side_actions,
    side_hits = v105_daily_settlement_analytics.side_hits + excluded.side_hits,
    tie_total = v105_daily_settlement_analytics.tie_total + excluded.tie_total,
    tie_hits = v105_daily_settlement_analytics.tie_hits + excluded.tie_hits,
    dragon_total = v105_daily_settlement_analytics.dragon_total + excluded.dragon_total,
    dragon_hits = v105_daily_settlement_analytics.dragon_hits + excluded.dragon_hits,
    pair_total = v105_daily_settlement_analytics.pair_total + excluded.pair_total,
    pair_hits = v105_daily_settlement_analytics.pair_hits + excluded.pair_hits,
    six_total = v105_daily_settlement_analytics.six_total + excluded.six_total,
    six_hits = v105_daily_settlement_analytics.six_hits + excluded.six_hits,
    updated_at = now();
end;
$function$
;

-- Minimal exact-definition delta: rebuild_v100_rank_ledger_from_cloud_rounds
CREATE OR REPLACE FUNCTION public.rebuild_v100_rank_ledger_from_cloud_rounds(p_source text, p_table_id text, p_shoe_no text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  latest_shoe text;
  min_round integer;
  max_round integer;
  row_count integer;
  distinct_round_count integer;
  round_row record;
  apply_result jsonb;
  final_ledger public.shoe_rank_ledgers%rowtype;
begin
  if nullif(p_source,'') is null or nullif(p_table_id,'') is null or nullif(p_shoe_no,'') is null
     or p_table_id not in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10','BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06')
     or (p_table_id in ('BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06') and p_source is distinct from 'ofalive99') then
    raise exception 'invalid v100 rank recovery identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v100-rank|'||p_source||'|'||p_table_id||'|'||p_shoe_no,0)
  );

  select shoe_no into latest_shoe
  from public.cloud_table_rounds
  where source=p_source and table_id=p_table_id
  order by received_at desc,round_no desc
  limit 1;
  if latest_shoe is distinct from p_shoe_no then
    raise exception 'v100 rank recovery accepts only the current authoritative shoe';
  end if;

  select min(round_no),max(round_no),count(*)::integer,count(distinct round_no)::integer
    into min_round,max_round,row_count,distinct_round_count
  from public.cloud_table_rounds
  where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no;
  if min_round is distinct from 1 or max_round is null
     or row_count is distinct from max_round or distinct_round_count is distinct from max_round then
    raise exception 'v100 rank recovery authoritative shoe is incomplete';
  end if;

  for round_row in
    select round_no,raw_event
    from public.cloud_table_rounds
    where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no
    order by round_no
    for share
  loop
    apply_result:=public.apply_v100_rank_ledger_event(jsonb_build_object(
      'source',p_source,
      'table_id',p_table_id,
      'shoe_no',p_shoe_no,
      'round_no',round_row.round_no,
      'source_action',round_row.raw_event->>'sourceAction',
      'raw_result_exact10',round_row.raw_event->'rawResult'
    ));
    if apply_result->'accepted' is distinct from 'true'::jsonb
       or apply_result->>'status' is distinct from 'contiguous' then
      raise exception 'v100 rank recovery rejected round %',round_row.round_no;
    end if;
  end loop;

  select * into final_ledger
  from public.shoe_rank_ledgers
  where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no
  for share;
  if final_ledger.status is distinct from 'contiguous'
     or final_ledger.complete_through_round is distinct from max_round then
    raise exception 'v100 rank recovery did not reach the authoritative Final';
  end if;

  return jsonb_build_object(
    'accepted',true,
    'source',p_source,
    'table_id',p_table_id,
    'shoe_no',p_shoe_no,
    'complete_through_round',max_round,
    'status',final_ledger.status,
    'remaining_rank_counts',final_ledger.undealt_after_observed_deals
  );
end;
$function$
;

-- Historical-only backfill definitions deliberately untouched.
COMMIT;
