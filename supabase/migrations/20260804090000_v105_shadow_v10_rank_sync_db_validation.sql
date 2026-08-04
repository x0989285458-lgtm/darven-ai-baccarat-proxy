begin;

revoke execute on function public.issue_v105_shadow_v10_rank_sync_prediction(jsonb) from service_role;

create or replace function public.issue_v105_shadow_v10_rank_sync_prediction(p_prediction jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
as $$
declare
  issued public.v105_shadow_v10_rank_sync_issuances%rowtype;
  score_banker numeric;
  score_player numeric;
  expected_direction text;
  expected_confidence numeric;
  rank_evidence jsonb;
  remaining_rank_count_sum integer;
  side_key text;
  side_head jsonb;
  expected_side_weights_by_head jsonb;
  expected_side_weights jsonb;
  expected_side_confidence numeric;
  expected_side_action boolean;
  expected_side_units integer;
  side_threshold numeric;
  authoritative_round_count integer;
  authoritative_distinct_round_count integer;
  authoritative_min_round integer;
  authoritative_max_round integer;
  authoritative_rounds_valid boolean;
  authoritative_rank_counts jsonb;
  authoritative_rank_total integer;
  authoritative_rank_pressure numeric;
  authoritative_rank_total_feature numeric;
begin
  perform 1 from public.ai_strategy_versions where status='active' and version='v105';
  if not found or (select count(*) from public.ai_strategy_versions where status='active') <> 1 then
    raise exception 'v105 Active strategy verification failed';
  end if;
  perform 1 from public.v105_shadow_v10_rank_sync_runtime_settings
    where release_candidate='v105-shadow-v10-big-road-uncommon-structure-rank-synchronized' and strategy_version='v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
      and status='shadow' and enabled=true and active_strategy_version='v105'
    for share;
  if not found then raise exception 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized is disabled'; end if;

  score_banker :=
      (p_prediction->'prediction_payload'->'scoreSources'->'v7RoadCycle'->>'banker')::numeric * 0.315
    + (p_prediction->'prediction_payload'->'scoreSources'->'v8AskRoad'->>'banker')::numeric * 0.315
    + (p_prediction->'prediction_payload'->'scoreSources'->'recentPracticalCalibration'->>'banker')::numeric * 0.18
    + (p_prediction->'prediction_payload'->'scoreSources'->'shoeBankerPlayerBias'->>'banker')::numeric * 0.09
    + (p_prediction->'prediction_payload'->'scoreSources'->'uncommonRoadStructure'->>'banker')::numeric * 0.10;
  score_player :=
      (p_prediction->'prediction_payload'->'scoreSources'->'v7RoadCycle'->>'player')::numeric * 0.315
    + (p_prediction->'prediction_payload'->'scoreSources'->'v8AskRoad'->>'player')::numeric * 0.315
    + (p_prediction->'prediction_payload'->'scoreSources'->'recentPracticalCalibration'->>'player')::numeric * 0.18
    + (p_prediction->'prediction_payload'->'scoreSources'->'shoeBankerPlayerBias'->>'player')::numeric * 0.09
    + (p_prediction->'prediction_payload'->'scoreSources'->'uncommonRoadStructure'->>'player')::numeric * 0.10;
  expected_direction := case
    when abs(score_banker-score_player) <= 0.000000000001
      then p_prediction->'prediction_payload'->>'v9BaseDirection'
    when score_banker > score_player then 'banker'
    else 'player'
  end;
  expected_confidence := greatest(30,least(70,round(30+abs(score_banker-score_player)*100)));

  if nullif(p_prediction->>'source','') is null
     or nullif(p_prediction->>'table_id','') is null
     or p_prediction->>'table_id' not in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')
     or nullif(p_prediction->>'shoe_no','') is null
     or coalesce((p_prediction->>'round_no')::integer,0) < 1
     or p_prediction->>'strategy_version' is distinct from 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
     or p_prediction->>'prediction_timing' is distinct from 'pre_result_context'
     or p_prediction->>'predicted_result' not in ('banker','player')
     or coalesce((p_prediction->>'confidence')::numeric,-1) not between 0 and 100
     or coalesce((p_prediction->>'same_side_streak')::integer,0) < 1
     or jsonb_typeof(p_prediction->'prediction_payload') is distinct from 'object'
     or p_prediction->'prediction_payload'->>'strategyVersion' is distinct from 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
     or p_prediction->'prediction_payload'->>'releaseCandidate' is distinct from 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized'
     or p_prediction->'prediction_payload'->>'formalStrategyVersion' is distinct from 'v105'
     or p_prediction->'prediction_payload'->>'predictionTiming' is distinct from 'pre_result_context'
     or p_prediction->'prediction_payload'->'shadowOnly' is distinct from 'true'::jsonb
     or p_prediction->'prediction_payload'->'activationEligible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'memberVisible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'writesSideActions' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'featureWeights' is distinct from
       '{"v7RoadCycle":0.315,"v8AskRoad":0.315,"recentPracticalCalibration":0.18,"shoeBankerPlayerBias":0.09,"uncommonRoadStructure":0.10}'::jsonb
     or jsonb_typeof(p_prediction->'prediction_payload'->'signals') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_prediction->'prediction_payload'->'signals')) <> 5
     or jsonb_typeof(p_prediction->'prediction_payload'->'signals'->'v7RoadCycle') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'signals'->'v8AskRoad') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'signals'->'recentPracticalCalibration') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'signals'->'shoeBankerPlayerBias') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'signals'->'uncommonRoadStructure') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'structureDiagnostics') is distinct from 'object'
     or p_prediction->'prediction_payload'->'signals'->'uncommonRoadStructure' is distinct from
       p_prediction->'prediction_payload'->'structureDiagnostics'
     or jsonb_typeof(p_prediction->'prediction_payload'->'scoreSources') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_prediction->'prediction_payload'->'scoreSources')) <> 5
     or p_prediction->'prediction_payload'->'scoreSources'->'v7RoadCycle' not in
       ('{"banker":0.55,"player":0.45}'::jsonb,'{"banker":0.45,"player":0.55}'::jsonb)
     or p_prediction->'prediction_payload'->'scoreSources'->'v8AskRoad' not in
       ('{"banker":0.55,"player":0.45}'::jsonb,'{"banker":0.45,"player":0.55}'::jsonb)
     or p_prediction->'prediction_payload'->'scoreSources'->'recentPracticalCalibration' is distinct from
       p_prediction->'prediction_payload'->'signals'->'recentPracticalCalibration'
     or p_prediction->'prediction_payload'->'scoreSources'->'shoeBankerPlayerBias' is distinct from
       p_prediction->'prediction_payload'->'signals'->'shoeBankerPlayerBias'
     or p_prediction->'prediction_payload'->'scoreSources'->'uncommonRoadStructure' not in
       ('{"banker":0.55,"player":0.45}'::jsonb,'{"banker":0.45,"player":0.55}'::jsonb,'{"banker":0.5,"player":0.5}'::jsonb)
     or (p_prediction->'prediction_payload'->'structureDiagnostics'->'eligible' is distinct from 'true'::jsonb
       and p_prediction->'prediction_payload'->'scoreSources'->'uncommonRoadStructure' is distinct from '{"banker":0.5,"player":0.5}'::jsonb)
     or (p_prediction->'prediction_payload'->'structureDiagnostics'->'eligible' is distinct from 'false'::jsonb
       and p_prediction->'prediction_payload'->'scoreSources'->'uncommonRoadStructure' is distinct from
         case p_prediction->'prediction_payload'->'structureDiagnostics'->>'direction'
           when 'banker' then '{"banker":0.55,"player":0.45}'::jsonb
           when 'player' then '{"banker":0.45,"player":0.55}'::jsonb
           else '{}'::jsonb end)
     or jsonb_typeof(p_prediction->'prediction_payload'->'scoreTotals') is distinct from 'object'
     or p_prediction->'prediction_payload'->>'v9BaseDirection' not in ('banker','player')
     or coalesce(abs((p_prediction->'prediction_payload'->'scoreTotals'->>'banker')::numeric-score_banker),999) > 0.000000000001
     or coalesce(abs((p_prediction->'prediction_payload'->'scoreTotals'->>'player')::numeric-score_player),999) > 0.000000000001
     or p_prediction->'prediction_payload'->>'predictedResult' is distinct from expected_direction
     or p_prediction->'prediction_payload'->'heads'->'main'->>'predictedResult' is distinct from expected_direction
     or (p_prediction->'prediction_payload'->>'confidence')::numeric is distinct from expected_confidence
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternSignal') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'askRoadSignal') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'askRoadSignal'->'roads') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'askRoadSignal'->'votes') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'decodedRecentRuns') is distinct from 'array'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows'->'near6') is distinct from 'array'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows'->'near12') is distinct from 'array'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows'->'background24') is distinct from 'array'
     or p_prediction->'prediction_payload'->>'predictedResult' is distinct from p_prediction->>'predicted_result'
     or (p_prediction->'prediction_payload'->>'confidence')::numeric is distinct from (p_prediction->>'confidence')::numeric
     or (p_prediction->'prediction_payload'->>'sameSideStreak')::integer is distinct from (p_prediction->>'same_side_streak')::integer
     or coalesce((p_prediction->>'independent_support_count')::integer,-1) not between 0 and 2
     or (p_prediction->'prediction_payload'->>'independentSupportCount')::integer is distinct from (p_prediction->>'independent_support_count')::integer
     or p_prediction->>'shoe_bias_suppressed' not in ('true','false')
     or (p_prediction->'prediction_payload'->>'shoeBiasSuppressed')::boolean is distinct from (p_prediction->>'shoe_bias_suppressed')::boolean
     or p_prediction->>'lock_risk' not in ('true','false')
     or (p_prediction->'prediction_payload'->>'lockRisk')::boolean is distinct from (p_prediction->>'lock_risk')::boolean
     or jsonb_typeof(p_prediction->'prediction_payload'->'heads') is distinct from 'object'
     or not ((p_prediction->'prediction_payload'->'heads') ?& array['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'])
     or (select count(*) from jsonb_object_keys(p_prediction->'prediction_payload'->'heads')) <> 7
     or p_prediction->'prediction_payload'->'heads'->'main'->'action' is distinct from 'true'::jsonb
     or (p_prediction->'prediction_payload'->'heads'->'tie'->>'threshold')::numeric is distinct from 30::numeric
     or (p_prediction->'prediction_payload'->'heads'->'superSix'->>'threshold')::numeric is distinct from 50::numeric
     or (p_prediction->'prediction_payload'->'heads'->'bankerDragon'->>'threshold')::numeric is distinct from 40::numeric
     or (p_prediction->'prediction_payload'->'heads'->'playerDragon'->>'threshold')::numeric is distinct from 40::numeric
     or (p_prediction->'prediction_payload'->'heads'->'bankerPair'->>'threshold')::numeric is distinct from 50::numeric
     or (p_prediction->'prediction_payload'->'heads'->'playerPair'->>'threshold')::numeric is distinct from 41::numeric
     or p_prediction->'prediction_payload'->>'targetTableId' is distinct from p_prediction->>'table_id'
     or p_prediction->'prediction_payload'->>'targetShoe' is distinct from p_prediction->>'shoe_no'
     or (p_prediction->'prediction_payload'->>'targetRound')::integer is distinct from (p_prediction->>'round_no')::integer then
    raise exception 'v105-shadow-v10-big-road-uncommon-structure-rank-synchronized issuance payload is invalid';
  end if;


  with authoritative_rounds as materialized (
    select round_no,raw_event from public.cloud_table_rounds
    where source=p_prediction->>'source' and table_id=p_prediction->>'table_id'
      and shoe_no=p_prediction->>'shoe_no'
      and round_no between 1 and (p_prediction->>'round_no')::integer-1
    for share
  ), cards as materialized (
    select r.round_no,card_position,
      case when jsonb_typeof(card_value)='number' and (card_value#>>'{}') ~ '^-?[0-9]+$'
        then (card_value#>>'{}')::integer else null end as card_code,
      jsonb_typeof(card_value) as card_type
    from authoritative_rounds r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.raw_event->'rawResult')='array' then r.raw_event->'rawResult' else '[]'::jsonb end
    ) with ordinality as card(card_value,card_position)
  ), round_stats as (
    select count(*)::integer as round_count,count(distinct round_no)::integer as distinct_round_count,
      min(round_no) as min_round,max(round_no) as max_round,
      coalesce(bool_and(case when jsonb_typeof(raw_event->'rawResult')='array'
        then raw_event->>'sourceAction'='summary' and jsonb_array_length(raw_event->'rawResult')=10
        else false end),false) as structurally_valid
    from authoritative_rounds
  ), card_stats as (
    select count(*)::integer as card_field_count,
      coalesce(bool_and(card_type='number' and card_code is not null and case
        when card_position between 1 and 4 then card_code between 1 and 52
        when card_position between 5 and 8 then card_code between -1 and 52
        when card_position between 9 and 10 then card_code between 0 and 9
        else false end),false) as values_valid
    from cards
  ), physical_limit as (
    select not exists (
      select 1 from cards where card_position<=6 and card_code between 1 and 52
      group by card_code having count(*)>8
    ) as valid
  ), rank_def(rank_name,rank_index) as (values
    ('A',0),('2',1),('3',2),('4',3),('5',4),('6',5),('7',6),('8',7),('9',8),('10',9),('J',10),('Q',11),('K',12)
  ), seen as (
    select mod(card_code-1,13) as rank_index,count(*)::integer as seen_count
    from cards where card_position<=6 and card_code between 1 and 52
    group by mod(card_code-1,13)
  ), rank_stats as (
    select jsonb_object_agg(rank_name,32-coalesce(seen_count,0)) as rank_counts,
      sum(32-coalesce(seen_count,0))::integer as rank_total,
      max(32-coalesce(seen_count,0))-min(32-coalesce(seen_count,0)) as rank_spread
    from rank_def left join seen using(rank_index)
  )
  select rs.round_count,rs.distinct_round_count,rs.min_round,rs.max_round,
    rs.structurally_valid and cs.values_valid
      and cs.card_field_count=rs.round_count*10 and pl.valid,
    rks.rank_counts,rks.rank_total,
    least(100,greatest(0,round((rks.rank_spread/greatest(1,rks.rank_total::numeric/13))*50))),
    least(100,greatest(0,round((rks.rank_total::numeric/416)*100)))
  into authoritative_round_count,authoritative_distinct_round_count,authoritative_min_round,
    authoritative_max_round,authoritative_rounds_valid,authoritative_rank_counts,
    authoritative_rank_total,authoritative_rank_pressure,authoritative_rank_total_feature
  from round_stats rs cross join card_stats cs cross join physical_limit pl cross join rank_stats rks;
  if authoritative_round_count is distinct from (p_prediction->>'round_no')::integer-1
     or authoritative_distinct_round_count is distinct from (p_prediction->>'round_no')::integer-1
     or authoritative_min_round is distinct from 1
     or authoritative_max_round is distinct from (p_prediction->>'round_no')::integer-1
     or authoritative_rounds_valid is distinct from true then
    raise exception 'V10 authoritative rank ledger is incomplete or invalid';
  end if;

  rank_evidence := p_prediction->'prediction_payload'->'rankLedgerEvidence';
  if jsonb_typeof(rank_evidence) is distinct from 'object'
     or rank_evidence->>'status' is distinct from 'contiguous'
     or rank_evidence->'rankDataAvailable' is distinct from 'true'::jsonb
     or (rank_evidence->>'completeThroughRound')::integer is distinct from (p_prediction->>'round_no')::integer - 1
     or (rank_evidence->>'targetRound')::integer is distinct from (p_prediction->>'round_no')::integer
     or jsonb_typeof(rank_evidence->'remainingRankCounts') is distinct from 'object'
     or not ((rank_evidence->'remainingRankCounts') ?& array['A','2','3','4','5','6','7','8','9','10','J','Q','K'])
     or (select count(*) from jsonb_object_keys(rank_evidence->'remainingRankCounts')) <> 13
     or exists (
       select 1 from jsonb_each(rank_evidence->'remainingRankCounts') as rank_count(rank_name,rank_value)
       where jsonb_typeof(rank_value)<>'number' or (rank_value#>>'{}') !~ '^[0-9]+$'
         or (rank_value#>>'{}')::integer not between 0 and 32
     ) then
    raise exception 'V10 rank ledger evidence is invalid';
  end if;
  select coalesce(sum((rank_value#>>'{}')::integer),0) into remaining_rank_count_sum
    from jsonb_each(rank_evidence->'remainingRankCounts') as rank_count(rank_name,rank_value);
  if remaining_rank_count_sum not between 0 and 416
     or (rank_evidence->>'cardsRemainingTotal')::integer is distinct from remaining_rank_count_sum
     or rank_evidence->'remainingRankCounts' is distinct from authoritative_rank_counts
     or remaining_rank_count_sum is distinct from authoritative_rank_total then
    raise exception 'V10 remaining rank count sum is invalid';
  end if;

  expected_side_weights_by_head := '{"tie":{"tie_count":0.1,"banker_pair_count":0,"player_pair_count":0,"bead_road":0,"big_road":0,"big_eye_road":0,"small_road":0,"cockroach_road":0,"next_banker_road":0,"next_player_road":0,"shoe":0,"round":0,"shoe_stage":0.1,"player_point":0,"banker_point":0,"point_diff":0,"banker_natural":0,"player_natural":0,"banker_dragon":0,"player_dragon":0,"super_six":0,"tie_risk":0.45,"pair_risk":0,"ask_road_conflict":0,"road_chaos":0.15,"table_side_history":0,"remaining_rank_pressure":0,"remaining_rank_total":0.2},"superSix":{"tie_count":0,"banker_pair_count":0,"player_pair_count":0,"bead_road":0,"big_road":0,"big_eye_road":0,"small_road":0,"cockroach_road":0,"next_banker_road":0,"next_player_road":0,"shoe":0,"round":0,"shoe_stage":0.1,"player_point":0,"banker_point":0.3,"point_diff":0,"banker_natural":0,"player_natural":0,"banker_dragon":0,"player_dragon":0,"super_six":0,"tie_risk":0,"pair_risk":0,"ask_road_conflict":0,"road_chaos":0,"table_side_history":0.25,"remaining_rank_pressure":0,"remaining_rank_total":0.35},"bankerDragon":{"tie_count":0,"banker_pair_count":0,"player_pair_count":0,"bead_road":0,"big_road":0.15,"big_eye_road":0,"small_road":0,"cockroach_road":0,"next_banker_road":0,"next_player_road":0,"shoe":0,"round":0,"shoe_stage":0,"player_point":0,"banker_point":0.35,"point_diff":0.1,"banker_natural":0.05,"player_natural":0,"banker_dragon":0,"player_dragon":0,"super_six":0,"tie_risk":0,"pair_risk":0,"ask_road_conflict":0,"road_chaos":0,"table_side_history":0,"remaining_rank_pressure":0,"remaining_rank_total":0.35},"playerDragon":{"tie_count":0,"banker_pair_count":0,"player_pair_count":0,"bead_road":0,"big_road":0.1,"big_eye_road":0,"small_road":0,"cockroach_road":0,"next_banker_road":0,"next_player_road":0,"shoe":0,"round":0,"shoe_stage":0,"player_point":0.35,"banker_point":0,"point_diff":0.15,"banker_natural":0,"player_natural":0.1,"banker_dragon":0,"player_dragon":0,"super_six":0,"tie_risk":0,"pair_risk":0,"ask_road_conflict":0,"road_chaos":0,"table_side_history":0,"remaining_rank_pressure":0,"remaining_rank_total":0.3},"bankerPair":{"tie_count":0,"banker_pair_count":0.2,"player_pair_count":0,"bead_road":0,"big_road":0,"big_eye_road":0,"small_road":0,"cockroach_road":0,"next_banker_road":0,"next_player_road":0,"shoe":0,"round":0,"shoe_stage":0.2,"player_point":0,"banker_point":0,"point_diff":0,"banker_natural":0,"player_natural":0,"banker_dragon":0,"player_dragon":0,"super_six":0,"tie_risk":0,"pair_risk":0.35,"ask_road_conflict":0,"road_chaos":0,"table_side_history":0.1,"remaining_rank_pressure":0.15,"remaining_rank_total":0},"playerPair":{"tie_count":0,"banker_pair_count":0,"player_pair_count":0.2,"bead_road":0,"big_road":0,"big_eye_road":0,"small_road":0,"cockroach_road":0,"next_banker_road":0,"next_player_road":0,"shoe":0,"round":0,"shoe_stage":0.15,"player_point":0,"banker_point":0,"point_diff":0,"banker_natural":0,"player_natural":0,"banker_dragon":0,"player_dragon":0,"super_six":0,"tie_risk":0,"pair_risk":0.2,"ask_road_conflict":0,"road_chaos":0,"table_side_history":0.25,"remaining_rank_pressure":0.2,"remaining_rank_total":0}}'::jsonb;
  foreach side_key in array array['tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'] loop
    side_head := p_prediction->'prediction_payload'->'heads'->side_key;
    expected_side_weights := expected_side_weights_by_head->side_key;
    if jsonb_typeof(side_head) is distinct from 'object'
       or side_head->>'key' is distinct from side_key
       or side_head->'rankAvailable' is distinct from 'true'::jsonb
       or jsonb_typeof(side_head->'featureValues') is distinct from 'object'
       or jsonb_typeof(side_head->'weights') is distinct from 'object'
       or side_head->'weights' is distinct from expected_side_weights
       or (select count(*) from jsonb_object_keys(side_head->'featureValues')) <> (select count(*) from jsonb_object_keys(expected_side_weights))
       or not ((side_head->'featureValues') ?& array(select jsonb_object_keys(expected_side_weights)))
       or exists (
         select 1 from jsonb_each(side_head->'featureValues') as feature(feature_name,feature_value)
         where jsonb_typeof(feature_value)<>'number'
           or (feature_value#>>'{}') !~ '^[0-9]+(?:\.[0-9]+)?$'
           or (feature_value#>>'{}')::numeric not between 0 and 100
       ) then
      raise exception 'V10 side-head evidence is invalid: %',side_key;
    end if;
    if coalesce(abs((side_head->'featureValues'->>'remaining_rank_pressure')::numeric-authoritative_rank_pressure),999)>0.000000001
       or coalesce(abs((side_head->'featureValues'->>'remaining_rank_total')::numeric-authoritative_rank_total_feature),999)>0.000000001 then
      raise exception 'V10 rank-derived side-head features are invalid: %',side_key;
    end if;
    select round(sum((feature.feature_value#>>'{}')::numeric * weight.weight_value::numeric),2)
      into expected_side_confidence
      from jsonb_each(side_head->'featureValues') as feature(feature_name,feature_value)
      join jsonb_each_text(expected_side_weights) as weight(weight_name,weight_value)
        on weight.weight_name=feature.feature_name;
    side_threshold := (side_head->>'threshold')::numeric;
    expected_side_action := expected_side_confidence >= side_threshold;
    expected_side_units := case when not expected_side_action then 0 else
      greatest(1,least(10,round(1+((expected_side_confidence-side_threshold)*9/(100-side_threshold)))::integer)) end;
    if coalesce(abs((side_head->>'confidence')::numeric - expected_side_confidence),999) > 0.000000001
       or (side_head->>'action')::boolean is distinct from expected_side_action
       or (side_head->>'units')::integer is distinct from expected_side_units then
      raise exception 'V10 side-head derived values are invalid: %',side_key;
    end if;
  end loop;

  insert into public.v105_shadow_v10_rank_sync_issuances (
    source,table_id,shoe_no,round_no,strategy_version,prediction_timing,predicted_result,
    confidence,same_side_streak,independent_support_count,shoe_bias_suppressed,lock_risk,prediction_payload
  ) values (
    p_prediction->>'source',p_prediction->>'table_id',p_prediction->>'shoe_no',(p_prediction->>'round_no')::integer,
    p_prediction->>'strategy_version',p_prediction->>'prediction_timing',p_prediction->>'predicted_result',
    (p_prediction->>'confidence')::numeric,(p_prediction->>'same_side_streak')::integer,
    (p_prediction->>'independent_support_count')::integer,(p_prediction->>'shoe_bias_suppressed')::boolean,
    (p_prediction->>'lock_risk')::boolean,p_prediction->'prediction_payload'
  ) on conflict (source,table_id,shoe_no,round_no,strategy_version) do nothing;

  select * into issued from public.v105_shadow_v10_rank_sync_issuances
  where source=p_prediction->>'source' and table_id=p_prediction->>'table_id'
    and shoe_no=p_prediction->>'shoe_no' and round_no=(p_prediction->>'round_no')::integer
    and strategy_version='v105-shadow-v10-big-road-uncommon-structure-rank-synchronized';
  if not found or issued.prediction_payload is distinct from p_prediction->'prediction_payload' then
    raise exception 'conflicting v105-shadow-v10-big-road-uncommon-structure-rank-synchronized issuance';
  end if;
  return jsonb_build_object('prediction_id',issued.id,'prediction_issued_at',issued.prediction_issued_at,'prediction',issued.prediction_payload);
end;
$$;

grant execute on function public.issue_v105_shadow_v10_rank_sync_prediction(jsonb) to service_role;

commit;
