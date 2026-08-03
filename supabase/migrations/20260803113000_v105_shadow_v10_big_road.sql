-- v105-shadow-v10-big-road-uncommon-structure: backend-only ask-road shadow persistence, isolated from V5/V6 and every prior shadow version.
begin;

create table if not exists public.v105_shadow_v10_big_road_runtime_settings (
  release_candidate text primary key,
  strategy_version text not null check (strategy_version = 'v105-shadow-v10-big-road-uncommon-structure'),
  status text not null check (status in ('shadow','shadow_disabled')),
  enabled boolean not null,
  active_strategy_version text not null check (active_strategy_version = 'v105'),
  updated_at timestamptz not null default now()
);

create table if not exists public.v105_shadow_v10_big_road_sequence_counters (
  release_candidate text primary key,
  settlement_count bigint not null default 0 check (settlement_count >= 0),
  main_action_count bigint not null default 0 check (main_action_count >= 0),
  tie_action_count bigint not null default 0 check (tie_action_count >= 0),
  super_six_action_count bigint not null default 0 check (super_six_action_count >= 0),
  banker_dragon_action_count bigint not null default 0 check (banker_dragon_action_count >= 0),
  player_dragon_action_count bigint not null default 0 check (player_dragon_action_count >= 0),
  banker_pair_action_count bigint not null default 0 check (banker_pair_action_count >= 0),
  player_pair_action_count bigint not null default 0 check (player_pair_action_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.v105_shadow_v10_big_road_issuances (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  table_id text not null check (table_id in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')),
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v105-shadow-v10-big-road-uncommon-structure'),
  prediction_timing text not null check (prediction_timing = 'pre_result_context'),
  prediction_issued_at timestamptz not null default now(),
  predicted_result text not null check (predicted_result in ('banker','player')),
  confidence numeric not null check (confidence between 0 and 100),
  same_side_streak integer not null check (same_side_streak > 0),
  independent_support_count integer not null check (independent_support_count between 0 and 2),
  shoe_bias_suppressed boolean not null,
  lock_risk boolean not null,
  prediction_payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint v105_shadow_v10_big_road_issuance_identity_unique unique (source,table_id,shoe_no,round_no,strategy_version)
);

create table if not exists public.v105_shadow_v10_big_road_settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_sequence bigint not null unique check (settlement_sequence > 0),
  main_action_sequence bigint unique,
  tie_action_sequence bigint unique,
  super_six_action_sequence bigint unique,
  banker_dragon_action_sequence bigint unique,
  player_dragon_action_sequence bigint unique,
  banker_pair_action_sequence bigint unique,
  player_pair_action_sequence bigint unique,
  prediction_id uuid not null unique references public.v105_shadow_v10_big_road_issuances(id),
  source text not null,
  table_id text not null check (table_id in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')),
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v105-shadow-v10-big-road-uncommon-structure'),
  predicted_result text not null check (predicted_result in ('banker','player')),
  actual_result text not null check (actual_result in ('banker','player','tie')),
  actual_facts jsonb not null,
  is_hit boolean,
  settlement_status text not null check (settlement_status in ('hit','miss','push')),
  settlement_final boolean not null check (settlement_final = true),
  settlement_source_action text not null check (settlement_source_action in ('summary','show_win')),
  head_results jsonb not null,
  resolved_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint v105_shadow_v10_big_road_main_semantics check (
    (actual_result='tie' and settlement_status='push' and is_hit is null)
    or (actual_result<>'tie' and settlement_status in ('hit','miss') and is_hit is not null)
  )
);

create index if not exists v105_shadow_v10_big_road_issuances_issued_idx
  on public.v105_shadow_v10_big_road_issuances (prediction_issued_at desc,id desc);
create index if not exists v105_shadow_v10_big_road_settlements_resolved_idx
  on public.v105_shadow_v10_big_road_settlements (resolved_at desc,prediction_id);

alter table public.v105_shadow_v10_big_road_runtime_settings enable row level security;
alter table public.v105_shadow_v10_big_road_sequence_counters enable row level security;
alter table public.v105_shadow_v10_big_road_issuances enable row level security;
alter table public.v105_shadow_v10_big_road_settlements enable row level security;

revoke all on table public.v105_shadow_v10_big_road_runtime_settings from public,anon,authenticated,service_role;
revoke all on table public.v105_shadow_v10_big_road_sequence_counters from public,anon,authenticated,service_role;
revoke all on table public.v105_shadow_v10_big_road_issuances from public,anon,authenticated,service_role;
revoke all on table public.v105_shadow_v10_big_road_settlements from public,anon,authenticated,service_role;
grant select on table public.v105_shadow_v10_big_road_runtime_settings to service_role;
grant select on table public.v105_shadow_v10_big_road_sequence_counters to service_role;
grant select on table public.v105_shadow_v10_big_road_issuances to service_role;
grant select on table public.v105_shadow_v10_big_road_settlements to service_role;

insert into public.v105_shadow_v10_big_road_runtime_settings (
  release_candidate,strategy_version,status,enabled,active_strategy_version,updated_at
) values ('v105-shadow-v10-big-road-uncommon-structure','v105-shadow-v10-big-road-uncommon-structure','shadow',true,'v105',now())
on conflict (release_candidate) do nothing;

insert into public.v105_shadow_v10_big_road_sequence_counters (release_candidate,settlement_count)
values ('v105-shadow-v10-big-road-uncommon-structure',0)
on conflict (release_candidate) do nothing;

create or replace function public.issue_v105_shadow_v10_big_road_prediction(p_prediction jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
as $$
declare
  issued public.v105_shadow_v10_big_road_issuances%rowtype;
  score_banker numeric;
  score_player numeric;
  expected_direction text;
  expected_confidence numeric;
begin
  perform 1 from public.ai_strategy_versions where status='active' and version='v105';
  if not found or (select count(*) from public.ai_strategy_versions where status='active') <> 1 then
    raise exception 'v105 Active strategy verification failed';
  end if;
  perform 1 from public.v105_shadow_v10_big_road_runtime_settings
    where release_candidate='v105-shadow-v10-big-road-uncommon-structure' and strategy_version='v105-shadow-v10-big-road-uncommon-structure'
      and status='shadow' and enabled=true and active_strategy_version='v105'
    for share;
  if not found then raise exception 'v105-shadow-v10-big-road-uncommon-structure is disabled'; end if;

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
     or p_prediction->>'strategy_version' is distinct from 'v105-shadow-v10-big-road-uncommon-structure'
     or p_prediction->>'prediction_timing' is distinct from 'pre_result_context'
     or p_prediction->>'predicted_result' not in ('banker','player')
     or coalesce((p_prediction->>'confidence')::numeric,-1) not between 0 and 100
     or coalesce((p_prediction->>'same_side_streak')::integer,0) < 1
     or jsonb_typeof(p_prediction->'prediction_payload') is distinct from 'object'
     or p_prediction->'prediction_payload'->>'strategyVersion' is distinct from 'v105-shadow-v10-big-road-uncommon-structure'
     or p_prediction->'prediction_payload'->>'releaseCandidate' is distinct from 'v105-shadow-v10-big-road-uncommon-structure'
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
    raise exception 'v105-shadow-v10-big-road-uncommon-structure issuance payload is invalid';
  end if;

  insert into public.v105_shadow_v10_big_road_issuances (
    source,table_id,shoe_no,round_no,strategy_version,prediction_timing,predicted_result,
    confidence,same_side_streak,independent_support_count,shoe_bias_suppressed,lock_risk,prediction_payload
  ) values (
    p_prediction->>'source',p_prediction->>'table_id',p_prediction->>'shoe_no',(p_prediction->>'round_no')::integer,
    p_prediction->>'strategy_version',p_prediction->>'prediction_timing',p_prediction->>'predicted_result',
    (p_prediction->>'confidence')::numeric,(p_prediction->>'same_side_streak')::integer,
    (p_prediction->>'independent_support_count')::integer,(p_prediction->>'shoe_bias_suppressed')::boolean,
    (p_prediction->>'lock_risk')::boolean,p_prediction->'prediction_payload'
  ) on conflict (source,table_id,shoe_no,round_no,strategy_version) do nothing;

  select * into issued from public.v105_shadow_v10_big_road_issuances
  where source=p_prediction->>'source' and table_id=p_prediction->>'table_id'
    and shoe_no=p_prediction->>'shoe_no' and round_no=(p_prediction->>'round_no')::integer
    and strategy_version='v105-shadow-v10-big-road-uncommon-structure';
  if not found or issued.prediction_payload is distinct from p_prediction->'prediction_payload' then
    raise exception 'conflicting v105-shadow-v10-big-road-uncommon-structure issuance';
  end if;
  return jsonb_build_object('prediction_id',issued.id,'prediction_issued_at',issued.prediction_issued_at,'prediction',issued.prediction_payload);
end;
$$;

create or replace function public.settle_v105_shadow_v10_big_road_prediction(p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
as $$
declare
  issued public.v105_shadow_v10_big_road_issuances%rowtype;
  existing public.v105_shadow_v10_big_road_settlements%rowtype;
  counters public.v105_shadow_v10_big_road_sequence_counters%rowtype;
  next_sequence bigint;
  expected text;
  head_key text;
  head jsonb;
  issued_head jsonb;
  issued_action boolean;
  expected_head_status text;
  expected_hit boolean;
  payout numeric;
  fixed_stake numeric;
  weighted_stake numeric;
  fixed_net numeric;
  weighted_net numeric;
  issued_units numeric;
begin
  if p_settlement->>'strategy_version' is distinct from 'v105-shadow-v10-big-road-uncommon-structure'
     or p_settlement->'settlement_final' is distinct from 'true'::jsonb
     or p_settlement->>'settlement_source_action' not in ('summary','show_win')
     or p_settlement->>'actual_result' not in ('banker','player','tie')
     or jsonb_typeof(p_settlement->'actual_facts') is distinct from 'object'
     or jsonb_typeof(p_settlement->'head_results') is distinct from 'object' then
    raise exception 'v105-shadow-v10-big-road-uncommon-structure settlement payload is invalid';
  end if;
  select * into issued from public.v105_shadow_v10_big_road_issuances
    where id=(p_settlement->>'prediction_id')::uuid for update;
  if not found
     or issued.strategy_version <> 'v105-shadow-v10-big-road-uncommon-structure'
     or issued.source is distinct from p_settlement->>'source'
     or issued.table_id is distinct from p_settlement->>'table_id'
     or issued.shoe_no is distinct from p_settlement->>'shoe_no'
     or issued.round_no is distinct from (p_settlement->>'round_no')::integer
     or issued.predicted_result is distinct from p_settlement->>'predicted_result'
     or not ((p_settlement->'head_results') ?& array['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'])
     or (select count(*) from jsonb_object_keys(p_settlement->'head_results')) <> 7 then
    raise exception 'v105-shadow-v10-big-road-uncommon-structure settlement identity mismatch';
  end if;

  if jsonb_typeof(p_settlement->'actual_facts'->'bankerCardRanks') is distinct from 'array'
     or jsonb_typeof(p_settlement->'actual_facts'->'playerCardRanks') is distinct from 'array' then
    raise exception 'V10 big-road-only exact card ranks are required';
  end if;
  if jsonb_array_length(p_settlement->'actual_facts'->'bankerCardRanks') not between 2 and 3
     or jsonb_array_length(p_settlement->'actual_facts'->'playerCardRanks') not between 2 and 3
     or exists (select 1 from jsonb_array_elements_text(p_settlement->'actual_facts'->'bankerCardRanks') value where value !~ '^[0-9]+$' or value::integer not between 1 and 13)
     or exists (select 1 from jsonb_array_elements_text(p_settlement->'actual_facts'->'playerCardRanks') value where value !~ '^[0-9]+$' or value::integer not between 1 and 13) then
    raise exception 'V10 big-road-only exact card ranks are invalid';
  end if;
  if (p_settlement->'actual_facts'->>'bankerPoints')::integer is distinct from
       (select mod(sum(least(value::integer,10)),10) from jsonb_array_elements_text(p_settlement->'actual_facts'->'bankerCardRanks') value)
     or (p_settlement->'actual_facts'->>'playerPoints')::integer is distinct from
       (select mod(sum(least(value::integer,10)),10) from jsonb_array_elements_text(p_settlement->'actual_facts'->'playerCardRanks') value)
     or p_settlement->>'actual_result' is distinct from (case
       when (p_settlement->'actual_facts'->>'bankerPoints')::integer > (p_settlement->'actual_facts'->>'playerPoints')::integer then 'banker'
       when (p_settlement->'actual_facts'->>'playerPoints')::integer > (p_settlement->'actual_facts'->>'bankerPoints')::integer then 'player' else 'tie' end)
     or (p_settlement->'actual_facts'->>'bankerPair')::boolean is distinct from
       ((p_settlement->'actual_facts'->'bankerCardRanks'->>0)::integer = (p_settlement->'actual_facts'->'bankerCardRanks'->>1)::integer)
     or (p_settlement->'actual_facts'->>'playerPair')::boolean is distinct from
       ((p_settlement->'actual_facts'->'playerCardRanks'->>0)::integer = (p_settlement->'actual_facts'->'playerCardRanks'->>1)::integer)
     or (p_settlement->'actual_facts'->>'bankerNatural')::boolean is distinct from
       (jsonb_array_length(p_settlement->'actual_facts'->'bankerCardRanks')=2 and (p_settlement->'actual_facts'->>'bankerPoints')::integer in (8,9))
     or (p_settlement->'actual_facts'->>'playerNatural')::boolean is distinct from
       (jsonb_array_length(p_settlement->'actual_facts'->'playerCardRanks')=2 and (p_settlement->'actual_facts'->>'playerPoints')::integer in (8,9)) then
    raise exception 'V10 big-road-only actual facts do not match exact cards';
  end if;
  if (p_settlement->'actual_facts'->>'tie')::boolean is distinct from (p_settlement->>'actual_result'='tie')
     or (p_settlement->'actual_facts'->>'bankerPoints')::integer not between 0 and 9
     or (p_settlement->'actual_facts'->>'playerPoints')::integer not between 0 and 9
     or (p_settlement->'actual_facts'->>'pointDiff')::integer is distinct from abs((p_settlement->'actual_facts'->>'bankerPoints')::integer-(p_settlement->'actual_facts'->>'playerPoints')::integer)
     or (p_settlement->'actual_facts'->>'superSix')::boolean is distinct from (p_settlement->>'actual_result'='banker' and (p_settlement->'actual_facts'->>'bankerPoints')::integer=6)
     or (p_settlement->'actual_facts'->>'bankerDragon')::boolean is distinct from (p_settlement->>'actual_result'='banker' and ((p_settlement->'actual_facts'->>'bankerNatural')::boolean or (p_settlement->'actual_facts'->>'pointDiff')::integer>=4))
     or (p_settlement->'actual_facts'->>'playerDragon')::boolean is distinct from (p_settlement->>'actual_result'='player' and ((p_settlement->'actual_facts'->>'playerNatural')::boolean or (p_settlement->'actual_facts'->>'pointDiff')::integer>=4)) then
    raise exception 'V10 big-road-only actual facts are inconsistent';
  end if;

  expected := case when p_settlement->>'actual_result'='tie' then 'push'
    when p_settlement->>'actual_result'=issued.predicted_result then 'hit' else 'miss' end;
  if p_settlement->>'settlement_status' is distinct from expected
     or (expected='push' and p_settlement->'is_hit' is distinct from 'null'::jsonb)
     or (expected='hit' and (p_settlement->>'is_hit')::boolean is distinct from true)
     or (expected='miss' and (p_settlement->>'is_hit')::boolean is distinct from false) then
    raise exception 'V10 big-road-only main outcome is inconsistent';
  end if;

  foreach head_key in array array['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'] loop
    head := p_settlement->'head_results'->head_key;
    issued_head := issued.prediction_payload->'heads'->head_key;
    issued_action := case when head_key='main' then true else coalesce((issued_head->>'action')::boolean,false) end;
    if jsonb_typeof(head) is distinct from 'object' or (head->>'action')::boolean is distinct from issued_action then
      raise exception 'V10 big-road-only head action mismatch: %',head_key;
    end if;
    if not issued_action then
      if head->>'status' is distinct from 'no_action' or head->'isHit' is distinct from 'null'::jsonb
         or (head->>'fixedStakeUnits')::numeric is distinct from 0::numeric
         or (head->>'weightedStakeUnits')::numeric is distinct from 0::numeric
         or (head->>'fixedNetUnits')::numeric is distinct from 0::numeric
         or (head->>'weightedNetUnits')::numeric is distinct from 0::numeric then
        raise exception 'V10 big-road-only no-action result mismatch: %',head_key;
      end if;
      continue;
    end if;
    if head_key='main' then
      expected_head_status := expected;
      payout := case when issued.predicted_result='banker' then 0.95 else 1 end;
    else
      expected_hit := (p_settlement->'actual_facts'->>head_key)::boolean;
      expected_head_status := case when expected_hit then 'hit' else 'miss' end;
      payout := case
        when not expected_hit then 0
        when head_key='tie' then 8
        when head_key='superSix' then 12
        when head_key in ('bankerPair','playerPair') then 11
        when (head_key='bankerDragon' and (p_settlement->'actual_facts'->>'bankerNatural')::boolean)
          or (head_key='playerDragon' and (p_settlement->'actual_facts'->>'playerNatural')::boolean) then 1
        else case (p_settlement->'actual_facts'->>'pointDiff')::integer when 4 then 1 when 5 then 2 when 6 then 4 when 7 then 6 when 8 then 10 when 9 then 30 else 0 end
      end;
    end if;
    if head->>'status' is distinct from expected_head_status
       or (expected_head_status='push' and head->'isHit' is distinct from 'null'::jsonb)
       or (expected_head_status='hit' and (head->>'isHit')::boolean is distinct from true)
       or (expected_head_status='miss' and (head->>'isHit')::boolean is distinct from false) then
      raise exception 'V10 big-road-only head outcome mismatch: %',head_key;
    end if;
    fixed_stake := (head->>'fixedStakeUnits')::numeric;
    weighted_stake := (head->>'weightedStakeUnits')::numeric;
    fixed_net := (head->>'fixedNetUnits')::numeric;
    weighted_net := (head->>'weightedNetUnits')::numeric;
    issued_units := (issued_head->>'units')::numeric;
    if fixed_stake is distinct from 1::numeric or weighted_stake is distinct from issued_units
       or fixed_net is distinct from (case expected_head_status when 'push' then 0 when 'hit' then round(payout,3) else -1 end)
       or weighted_net is distinct from (case expected_head_status when 'push' then 0 when 'hit' then round(weighted_stake*payout,3) else round(-weighted_stake,3) end) then
      raise exception 'V10 big-road-only payout mismatch: %',head_key;
    end if;
  end loop;

  select * into existing from public.v105_shadow_v10_big_road_settlements where prediction_id=issued.id;
  if found then
    if existing.actual_result is distinct from p_settlement->>'actual_result'
       or existing.actual_facts is distinct from p_settlement->'actual_facts'
       or existing.head_results is distinct from p_settlement->'head_results'
       or existing.settlement_status is distinct from p_settlement->>'settlement_status'
       or existing.settlement_source_action is distinct from p_settlement->>'settlement_source_action'
       or existing.is_hit is distinct from (p_settlement->>'is_hit')::boolean
       or existing.resolved_at is distinct from (p_settlement->>'resolved_at')::timestamptz then
      raise exception 'conflicting v105-shadow-v10-big-road-uncommon-structure settlement';
    end if;
    return jsonb_build_object(
      'prediction_id',existing.prediction_id,'settlement_sequence',existing.settlement_sequence,'duplicate',true,
      'action_sequences',jsonb_build_object(
        'main_action_count',existing.main_action_sequence,'tie_action_count',existing.tie_action_sequence,
        'super_six_action_count',existing.super_six_action_sequence,
        'banker_dragon_action_count',existing.banker_dragon_action_sequence,
        'player_dragon_action_count',existing.player_dragon_action_sequence,
        'banker_pair_action_count',existing.banker_pair_action_sequence,
        'player_pair_action_count',existing.player_pair_action_sequence
      )
    );
  end if;

  select * into counters from public.v105_shadow_v10_big_road_sequence_counters
    where release_candidate='v105-shadow-v10-big-road-uncommon-structure' for update;
  if not found then raise exception 'v105-shadow-v10-big-road-uncommon-structure sequence counter is unavailable'; end if;
  next_sequence := counters.settlement_count + 1;
  insert into public.v105_shadow_v10_big_road_settlements (
    settlement_sequence,main_action_sequence,tie_action_sequence,super_six_action_sequence,
    banker_dragon_action_sequence,player_dragon_action_sequence,banker_pair_action_sequence,player_pair_action_sequence,
    prediction_id,source,table_id,shoe_no,round_no,strategy_version,predicted_result,
    actual_result,actual_facts,is_hit,settlement_status,settlement_final,settlement_source_action,
    head_results,resolved_at
  ) values (
    next_sequence,
    case when (issued.prediction_payload->'heads'->'main'->>'action')::boolean then counters.main_action_count+1 end,
    case when (issued.prediction_payload->'heads'->'tie'->>'action')::boolean then counters.tie_action_count+1 end,
    case when (issued.prediction_payload->'heads'->'superSix'->>'action')::boolean then counters.super_six_action_count+1 end,
    case when (issued.prediction_payload->'heads'->'bankerDragon'->>'action')::boolean then counters.banker_dragon_action_count+1 end,
    case when (issued.prediction_payload->'heads'->'playerDragon'->>'action')::boolean then counters.player_dragon_action_count+1 end,
    case when (issued.prediction_payload->'heads'->'bankerPair'->>'action')::boolean then counters.banker_pair_action_count+1 end,
    case when (issued.prediction_payload->'heads'->'playerPair'->>'action')::boolean then counters.player_pair_action_count+1 end,
    issued.id,issued.source,issued.table_id,issued.shoe_no,issued.round_no,issued.strategy_version,issued.predicted_result,
    p_settlement->>'actual_result',p_settlement->'actual_facts',(p_settlement->>'is_hit')::boolean,
    p_settlement->>'settlement_status',true,p_settlement->>'settlement_source_action',
    p_settlement->'head_results',(p_settlement->>'resolved_at')::timestamptz
  );
  update public.v105_shadow_v10_big_road_sequence_counters
    set settlement_count=next_sequence,
      main_action_count=main_action_count+case when (issued.prediction_payload->'heads'->'main'->>'action')::boolean then 1 else 0 end,
      tie_action_count=tie_action_count+case when (issued.prediction_payload->'heads'->'tie'->>'action')::boolean then 1 else 0 end,
      super_six_action_count=super_six_action_count+case when (issued.prediction_payload->'heads'->'superSix'->>'action')::boolean then 1 else 0 end,
      banker_dragon_action_count=banker_dragon_action_count+case when (issued.prediction_payload->'heads'->'bankerDragon'->>'action')::boolean then 1 else 0 end,
      player_dragon_action_count=player_dragon_action_count+case when (issued.prediction_payload->'heads'->'playerDragon'->>'action')::boolean then 1 else 0 end,
      banker_pair_action_count=banker_pair_action_count+case when (issued.prediction_payload->'heads'->'bankerPair'->>'action')::boolean then 1 else 0 end,
      player_pair_action_count=player_pair_action_count+case when (issued.prediction_payload->'heads'->'playerPair'->>'action')::boolean then 1 else 0 end,
      updated_at=now()
    where release_candidate='v105-shadow-v10-big-road-uncommon-structure'
    returning * into counters;
  return jsonb_build_object(
    'prediction_id',issued.id,'settlement_sequence',next_sequence,'duplicate',false,
    'action_sequences',jsonb_build_object(
      'main_action_count',counters.main_action_count,'tie_action_count',counters.tie_action_count,
      'super_six_action_count',counters.super_six_action_count,
      'banker_dragon_action_count',counters.banker_dragon_action_count,
      'player_dragon_action_count',counters.player_dragon_action_count,
      'banker_pair_action_count',counters.banker_pair_action_count,
      'player_pair_action_count',counters.player_pair_action_count
    )
  );
end;
$$;

create or replace view public.v105_shadow_v10_big_road_history
with (security_invoker=true)
as
select
  i.id as prediction_id,i.source,i.table_id,i.shoe_no,i.round_no,i.strategy_version,
  i.prediction_timing,i.prediction_issued_at,i.predicted_result,i.confidence,i.same_side_streak,
  i.independent_support_count,i.shoe_bias_suppressed,i.lock_risk,i.prediction_payload,
  s.actual_result,s.actual_facts,s.is_hit,s.settlement_status,
  coalesce(s.settlement_final,false) as settlement_final,s.settlement_source_action,
  s.head_results,s.resolved_at,s.settlement_sequence,s.main_action_sequence,s.tie_action_sequence,
  s.super_six_action_sequence,s.banker_dragon_action_sequence,s.player_dragon_action_sequence,
  s.banker_pair_action_sequence,s.player_pair_action_sequence
from public.v105_shadow_v10_big_road_issuances i
left join public.v105_shadow_v10_big_road_settlements s on s.prediction_id=i.id;

create or replace function public.get_v105_shadow_v10_big_road_compact_history(p_per_table_limit integer)
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
set search_path=pg_catalog,public
as $$
begin
  if p_per_table_limit is null or p_per_table_limit not between 1 and 60 then
    raise exception 'p_per_table_limit must be between 1 and 60' using errcode='22023';
  end if;
  return query
  with target_tables(target_table_id) as (
    values ('BAG01'),('BAG02'),('BAG03'),('BAG03A'),('BAG05'),
      ('BAG06'),('BAG07'),('BAG08'),('BAG09'),('BAG10')
  ), compact_rows as (
    select final_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id,i.source,i.table_id,i.shoe_no,i.round_no,
        i.strategy_version,i.prediction_timing,i.prediction_issued_at,i.predicted_result,
        i.same_side_streak,s.actual_result,true as settlement_final
      from public.v105_shadow_v10_big_road_issuances i
      inner join public.v105_shadow_v10_big_road_settlements s on s.prediction_id=i.id
      where i.table_id=t.target_table_id
        and i.source='ofalive99'
        and i.strategy_version='v105-shadow-v10-big-road-uncommon-structure'
        and i.prediction_timing='pre_result_context'
        and s.settlement_final=true
      order by i.prediction_issued_at desc,i.id desc
      limit p_per_table_limit
    ) final_row
    union all
    select pending_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id,i.source,i.table_id,i.shoe_no,i.round_no,
        i.strategy_version,i.prediction_timing,i.prediction_issued_at,i.predicted_result,
        i.same_side_streak,null::text as actual_result,false as settlement_final
      from public.v105_shadow_v10_big_road_issuances i
      where i.table_id=t.target_table_id
        and i.source='ofalive99'
        and i.strategy_version='v105-shadow-v10-big-road-uncommon-structure'
        and i.prediction_timing='pre_result_context'
        and not exists (
          select 1 from public.v105_shadow_v10_big_road_settlements final_settlement
          where final_settlement.prediction_id=i.id and final_settlement.settlement_final=true
        )
      order by i.prediction_issued_at desc,i.id desc
      limit 1
    ) pending_row
  )
  select compact.prediction_id,compact.source,compact.table_id,compact.shoe_no,compact.round_no,
    compact.strategy_version,compact.prediction_timing,compact.prediction_issued_at,
    compact.predicted_result,compact.same_side_streak,compact.actual_result,compact.settlement_final
  from compact_rows compact
  order by compact.prediction_issued_at asc,compact.prediction_id asc;
end;
$$;

revoke all on function public.issue_v105_shadow_v10_big_road_prediction(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.settle_v105_shadow_v10_big_road_prediction(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_v105_shadow_v10_big_road_compact_history(integer) from public,anon,authenticated,service_role;
grant execute on function public.issue_v105_shadow_v10_big_road_prediction(jsonb) to service_role;
grant execute on function public.settle_v105_shadow_v10_big_road_prediction(jsonb) to service_role;
grant execute on function public.get_v105_shadow_v10_big_road_compact_history(integer) to service_role;
revoke all on public.v105_shadow_v10_big_road_history from public,anon,authenticated,service_role;
grant select on public.v105_shadow_v10_big_road_history to service_role;

commit;
