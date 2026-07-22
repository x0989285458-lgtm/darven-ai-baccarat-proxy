-- v104.3.0 seven-head iteration shadow v3; additive and isolated from formal v104 and v1 shadow evidence.
begin;

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v104') then
    raise exception 'v104 must remain the only Active strategy';
  end if;
  if to_regclass('public.v103_shadow_runtime_settings') is not null then
    update public.v103_shadow_runtime_settings set enabled = false, status = 'shadow_disabled', updated_at = now();
  end if;
  if to_regclass('public.v104_shadow_runtime_settings') is not null then
    update public.v104_shadow_runtime_settings set enabled = false, status = 'shadow_disabled', updated_at = now();
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.v104_iteration_shadow_runtime_settings') is not null then
    update public.v104_iteration_shadow_runtime_settings
      set enabled=false, status='shadow_disabled', updated_at=now();
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.v104_iteration_shadow_v2_runtime_settings') is not null then
    update public.v104_iteration_shadow_v2_runtime_settings
      set enabled=false, status='shadow_disabled', updated_at=now();
  end if;
end;
$$;

create table if not exists public.v104_iteration_shadow_v3_runtime_settings (
  release_candidate text primary key,
  strategy_version text not null check (strategy_version = 'v104-seven-head-shadow-v3-main-player-pair-reweight'),
  status text not null check (status in ('shadow', 'shadow_disabled')),
  enabled boolean not null,
  active_strategy_version text not null check (active_strategy_version = 'v104'),
  updated_at timestamptz not null default now()
);

create table if not exists public.v104_iteration_shadow_v3_sequence_counters (
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

create table if not exists public.v104_iteration_shadow_v3_issuances (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  table_id text not null,
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v104-seven-head-shadow-v3-main-player-pair-reweight'),
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
  constraint v104_iteration_shadow_v3_issuance_identity_unique unique (source, table_id, shoe_no, round_no, strategy_version)
);

create table if not exists public.v104_iteration_shadow_v3_settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_sequence bigint not null unique,
  prediction_id uuid not null unique references public.v104_iteration_shadow_v3_issuances(id),
  source text not null,
  table_id text not null,
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v104-seven-head-shadow-v3-main-player-pair-reweight'),
  predicted_result text not null check (predicted_result in ('banker','player')),
  actual_result text not null check (actual_result in ('banker','player','tie')),
  actual_facts jsonb not null,
  is_hit boolean,
  settlement_status text not null check (settlement_status in ('hit','miss','push')),
  settlement_final boolean not null check (settlement_final = true),
  settlement_source_action text not null,
  head_results jsonb not null,
  resolved_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint v104_iteration_shadow_v3_main_semantics check (
    (actual_result = 'tie' and settlement_status = 'push' and is_hit is null)
    or (actual_result <> 'tie' and settlement_status in ('hit','miss') and is_hit is not null)
  )
);

-- manual stop only; no fixed settlement cap.

create table if not exists public.v104_iteration_shadow_v3_cycle_reports (
  id uuid primary key default gen_random_uuid(),
  cycle_number bigint not null unique check (cycle_number > 0),
  start_sequence bigint not null,
  end_sequence bigint not null,
  model_version text not null check (model_version = 'v104-seven-head-shadow-v3-main-player-pair-reweight'),
  report_payload jsonb not null,
  report_svg text not null,
  created_at timestamptz not null default now(),
  constraint v104_iteration_shadow_v3_cycle_exact check (
    start_sequence = ((cycle_number - 1) * 1000 + 1)
    and end_sequence = cycle_number * 1000
  )
);

create table if not exists public.v104_iteration_shadow_v3_weight_suggestions (
  suggestion_id text primary key,
  head_key text not null check (head_key in ('main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair')),
  action_cycle bigint not null check (action_cycle > 0),
  sample_start_action bigint not null,
  sample_end_action bigint not null,
  model_version text not null check (model_version = 'v104-seven-head-shadow-v3-main-player-pair-reweight'),
  search_method text not null check (search_method = 'exhaustive_5_percent_grid'),
  current_weights jsonb not null,
  suggested_weights jsonb not null,
  baseline_metrics jsonb not null,
  candidate_metrics jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  auto_apply boolean not null default false check (auto_apply = false),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (head_key, action_cycle),
  constraint v104_iteration_shadow_v3_action_cycle_exact check (
    sample_start_action = ((action_cycle - 1) * 1000 + 1)
    and sample_end_action = action_cycle * 1000
  )
);

alter table public.v104_iteration_shadow_v3_runtime_settings enable row level security;
alter table public.v104_iteration_shadow_v3_sequence_counters enable row level security;
alter table public.v104_iteration_shadow_v3_issuances enable row level security;
alter table public.v104_iteration_shadow_v3_settlements enable row level security;
alter table public.v104_iteration_shadow_v3_cycle_reports enable row level security;
alter table public.v104_iteration_shadow_v3_weight_suggestions enable row level security;

revoke all on table public.v104_iteration_shadow_v3_runtime_settings from public, anon, authenticated, service_role;
revoke all on table public.v104_iteration_shadow_v3_sequence_counters from public, anon, authenticated, service_role;
revoke all on table public.v104_iteration_shadow_v3_issuances from public, anon, authenticated, service_role;
revoke all on table public.v104_iteration_shadow_v3_settlements from public, anon, authenticated, service_role;
revoke all on table public.v104_iteration_shadow_v3_cycle_reports from public, anon, authenticated, service_role;
revoke all on table public.v104_iteration_shadow_v3_weight_suggestions from public, anon, authenticated, service_role;
grant select on table public.v104_iteration_shadow_v3_runtime_settings to service_role;
grant select on table public.v104_iteration_shadow_v3_sequence_counters to service_role;
grant select on table public.v104_iteration_shadow_v3_issuances to service_role;
grant select on table public.v104_iteration_shadow_v3_settlements to service_role;
grant select on table public.v104_iteration_shadow_v3_cycle_reports to service_role;
grant select on table public.v104_iteration_shadow_v3_weight_suggestions to service_role;

insert into public.v104_iteration_shadow_v3_runtime_settings (
  release_candidate, strategy_version, status, enabled, active_strategy_version, updated_at
) values ('v104.3.0-seven-head-shadow.3', 'v104-seven-head-shadow-v3-main-player-pair-reweight', 'shadow', true, 'v104', now())
on conflict (release_candidate) do nothing;

insert into public.v104_iteration_shadow_v3_sequence_counters (release_candidate)
values ('v104.3.0-seven-head-shadow.3') on conflict (release_candidate) do nothing;

create or replace function public.issue_v104_iteration_shadow_v3_prediction(p_prediction jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare issued public.v104_iteration_shadow_v3_issuances%rowtype; inserted boolean := false;
begin
  if (select count(*) from public.ai_strategy_versions where status='active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status='active' and version='v104') then
    raise exception 'v104 Active strategy verification failed';
  end if;
  perform 1 from public.v104_iteration_shadow_v3_runtime_settings
    where release_candidate='v104.3.0-seven-head-shadow.3' and enabled=true and status='shadow' and active_strategy_version='v104'
    for share;
  if not found then
    raise exception 'v104 iteration shadow is disabled';
  end if;
  if nullif(p_prediction->>'source','') is null or nullif(p_prediction->>'table_id','') is null
     or nullif(p_prediction->>'shoe_no','') is null or coalesce((p_prediction->>'round_no')::integer,0)<1
     or p_prediction->>'strategy_version' is distinct from 'v104-seven-head-shadow-v3-main-player-pair-reweight'
     or p_prediction->>'prediction_timing' is distinct from 'pre_result_context'
     or p_prediction->>'predicted_result' not in ('banker','player')
     or coalesce((p_prediction->>'same_side_streak')::integer,0)<1
     or jsonb_typeof(p_prediction->'prediction_payload') is distinct from 'object'
     or p_prediction->'prediction_payload'->>'strategyVersion' is distinct from 'v104-seven-head-shadow-v3-main-player-pair-reweight'
     or p_prediction->'prediction_payload'->>'releaseCandidate' is distinct from 'v104.3.0-seven-head-shadow.3'
     or p_prediction->>'source' is distinct from p_prediction->'prediction_payload'->>'source'
     or p_prediction->>'predicted_result' is distinct from p_prediction->'prediction_payload'->>'predictedResult'
     or (p_prediction->>'confidence')::numeric is distinct from (p_prediction->'prediction_payload'->>'confidence')::numeric
     or (p_prediction->>'same_side_streak')::integer is distinct from (p_prediction->'prediction_payload'->>'sameSideStreak')::integer
     or (p_prediction->>'independent_support_count')::integer is distinct from (p_prediction->'prediction_payload'->>'independentSupportCount')::integer
     or (p_prediction->>'shoe_bias_suppressed')::boolean is distinct from (p_prediction->'prediction_payload'->>'shoeBiasSuppressed')::boolean
     or (p_prediction->>'lock_risk')::boolean is distinct from (p_prediction->'prediction_payload'->>'lockRisk')::boolean
     or p_prediction->'prediction_payload'->>'formalStrategyVersion' is distinct from 'v104'
     or p_prediction->'prediction_payload'->>'predictionTiming' is distinct from 'pre_result_context'
     or p_prediction->'prediction_payload'->'shadowOnly' is distinct from 'true'::jsonb
     or p_prediction->'prediction_payload'->'activationEligible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'memberVisible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'writesSideActions' is distinct from 'false'::jsonb
     or jsonb_typeof(p_prediction->'prediction_payload'->'heads') is distinct from 'object'
     or not ((p_prediction->'prediction_payload'->'heads') ?& array['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'])
     or (select count(*) from jsonb_object_keys(p_prediction->'prediction_payload'->'heads')) <> 7
     or (p_prediction->'prediction_payload'->'heads'->'tie'->>'threshold')::numeric is distinct from 30::numeric
     or (p_prediction->'prediction_payload'->'heads'->'superSix'->>'threshold')::numeric is distinct from 50::numeric
     or (p_prediction->'prediction_payload'->'heads'->'bankerDragon'->>'threshold')::numeric is distinct from 40::numeric
     or (p_prediction->'prediction_payload'->'heads'->'playerDragon'->>'threshold')::numeric is distinct from 40::numeric
     or (p_prediction->'prediction_payload'->'heads'->'bankerPair'->>'threshold')::numeric is distinct from 50::numeric
     or (p_prediction->'prediction_payload'->'heads'->'playerPair'->>'threshold')::numeric is distinct from 41::numeric
     or p_prediction->'prediction_payload'->'heads'->'main'->'weights' is distinct from '{"roadmap_trend_signals":0.25,"ask_road_signals":0.35,"shoe_banker_player_bias":0.30,"neutral_reserve":0.10}'::jsonb
     or p_prediction->'prediction_payload'->'heads'->'playerPair'->'weights' is distinct from '{"remaining_rank_pressure":0.25,"shoe_stage":0.05,"player_pair_count":0.25,"player_pair_residual":0.15,"pair_shared_factor":0.30}'::jsonb
     or p_prediction->'prediction_payload'->>'targetTableId' is distinct from p_prediction->>'table_id'
     or p_prediction->'prediction_payload'->>'targetShoe' is distinct from p_prediction->>'shoe_no'
     or (p_prediction->'prediction_payload'->>'targetRound')::integer is distinct from (p_prediction->>'round_no')::integer then
    raise exception 'v104 iteration shadow issuance payload is incomplete';
  end if;
  insert into public.v104_iteration_shadow_v3_issuances (
    source,table_id,shoe_no,round_no,strategy_version,prediction_timing,predicted_result,confidence,
    same_side_streak,independent_support_count,shoe_bias_suppressed,lock_risk,prediction_payload
  ) values (
    p_prediction->>'source',p_prediction->>'table_id',p_prediction->>'shoe_no',(p_prediction->>'round_no')::integer,
    'v104-seven-head-shadow-v3-main-player-pair-reweight','pre_result_context',p_prediction->>'predicted_result',(p_prediction->>'confidence')::numeric,
    (p_prediction->>'same_side_streak')::integer,(p_prediction->>'independent_support_count')::integer,
    (p_prediction->>'shoe_bias_suppressed')::boolean,(p_prediction->>'lock_risk')::boolean,p_prediction->'prediction_payload'
  ) on conflict (source,table_id,shoe_no,round_no,strategy_version) do nothing returning * into issued;
  inserted := issued.id is not null;
  if not inserted then
    select * into issued from public.v104_iteration_shadow_v3_issuances where source=p_prediction->>'source'
      and table_id=p_prediction->>'table_id' and shoe_no=p_prediction->>'shoe_no'
      and round_no=(p_prediction->>'round_no')::integer and strategy_version='v104-seven-head-shadow-v3-main-player-pair-reweight';
    if issued.id is null or issued.prediction_payload is distinct from p_prediction->'prediction_payload' then
      raise exception 'conflicting v104 iteration shadow issuance';
    end if;
  end if;
  return jsonb_build_object('prediction_id',issued.id,'prediction_issued_at',issued.prediction_issued_at,
    'prediction',issued.prediction_payload,'duplicate',not inserted);
end; $$;

create or replace function public.settle_v104_iteration_shadow_v3_prediction(p_settlement jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare
  issued public.v104_iteration_shadow_v3_issuances%rowtype;
  settled public.v104_iteration_shadow_v3_settlements%rowtype;
  counter public.v104_iteration_shadow_v3_sequence_counters%rowtype;
  expected text; expected_head_status text; head_key text;
  head jsonb; issued_head jsonb;
  issued_action boolean; expected_hit boolean;
  fixed_stake numeric; weighted_stake numeric; fixed_net numeric; weighted_net numeric;
  issued_units numeric; payout numeric;
begin
  perform 1 from public.v104_iteration_shadow_v3_runtime_settings
    where release_candidate='v104.3.0-seven-head-shadow.3' and enabled=true and status='shadow' and active_strategy_version='v104'
    for share;
  if not found then
    raise exception 'v104 iteration shadow is disabled';
  end if;
  if coalesce(p_settlement->>'settlement_source_action','') not in ('summary','show_win') then
    raise exception 'v104 iteration shadow requires verified Final; show_poker is provisional';
  end if;
  select * into issued from public.v104_iteration_shadow_v3_issuances where id=(p_settlement->>'prediction_id')::uuid for update;
  if issued.id is null or issued.source is distinct from p_settlement->>'source'
     or issued.table_id is distinct from p_settlement->>'table_id' or issued.shoe_no is distinct from p_settlement->>'shoe_no'
     or issued.round_no is distinct from (p_settlement->>'round_no')::integer
     or issued.strategy_version is distinct from p_settlement->>'strategy_version'
     or issued.predicted_result is distinct from p_settlement->>'predicted_result'
     or coalesce((p_settlement->>'settlement_final')::boolean,false) is not true
     or p_settlement->>'actual_result' not in ('banker','player','tie')
     or jsonb_typeof(p_settlement->'actual_facts') is distinct from 'object'
     or jsonb_typeof(p_settlement->'head_results') is distinct from 'object'
     or not ((p_settlement->'head_results') ?& array['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'])
     or (select count(*) from jsonb_object_keys(p_settlement->'head_results')) <> 7 then
    raise exception 'v104 iteration shadow settlement identity mismatch';
  end if;
  if jsonb_typeof(p_settlement->'actual_facts'->'bankerCardRanks') is distinct from 'array'
     or jsonb_typeof(p_settlement->'actual_facts'->'playerCardRanks') is distinct from 'array' then
    raise exception 'v104 iteration shadow exact card ranks are required';
  end if;
  if jsonb_array_length(p_settlement->'actual_facts'->'bankerCardRanks') not between 2 and 3
     or jsonb_array_length(p_settlement->'actual_facts'->'playerCardRanks') not between 2 and 3
     or exists (select 1 from jsonb_array_elements_text(p_settlement->'actual_facts'->'bankerCardRanks') value where value !~ '^[0-9]+$' or value::integer not between 1 and 13)
     or exists (select 1 from jsonb_array_elements_text(p_settlement->'actual_facts'->'playerCardRanks') value where value !~ '^[0-9]+$' or value::integer not between 1 and 13) then
    raise exception 'v104 iteration shadow exact card ranks are invalid';
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
    raise exception 'v104 iteration shadow actual facts do not match exact cards';
  end if;
  if (p_settlement->'actual_facts'->>'tie')::boolean is distinct from (p_settlement->>'actual_result'='tie')
     or (p_settlement->'actual_facts'->>'bankerPoints')::integer not between 0 and 9
     or (p_settlement->'actual_facts'->>'playerPoints')::integer not between 0 and 9
     or (p_settlement->'actual_facts'->>'pointDiff')::integer is distinct from abs((p_settlement->'actual_facts'->>'bankerPoints')::integer-(p_settlement->'actual_facts'->>'playerPoints')::integer)
     or (p_settlement->'actual_facts'->>'superSix')::boolean is distinct from (p_settlement->>'actual_result'='banker' and (p_settlement->'actual_facts'->>'bankerPoints')::integer=6)
     or (p_settlement->'actual_facts'->>'bankerDragon')::boolean is distinct from (p_settlement->>'actual_result'='banker' and ((p_settlement->'actual_facts'->>'bankerNatural')::boolean or (p_settlement->'actual_facts'->>'pointDiff')::integer>=4))
     or (p_settlement->'actual_facts'->>'playerDragon')::boolean is distinct from (p_settlement->>'actual_result'='player' and ((p_settlement->'actual_facts'->>'playerNatural')::boolean or (p_settlement->'actual_facts'->>'pointDiff')::integer>=4)) then
    raise exception 'v104 iteration shadow actual facts are inconsistent';
  end if;

  expected := case when p_settlement->>'actual_result'='tie' then 'push'
    when p_settlement->>'actual_result'=issued.predicted_result then 'hit' else 'miss' end;
  if p_settlement->>'settlement_status' is distinct from expected
     or (expected='push' and p_settlement->'is_hit' <> 'null'::jsonb)
     or (expected='hit' and (p_settlement->>'is_hit')::boolean is distinct from true)
     or (expected='miss' and (p_settlement->>'is_hit')::boolean is distinct from false) then
    raise exception 'v104 iteration shadow main outcome is inconsistent';
  end if;

  foreach head_key in array array['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair'] loop
    head := p_settlement->'head_results'->head_key;
    issued_head := issued.prediction_payload->'heads'->head_key;
    issued_action := case when head_key='main' then true else coalesce((issued_head->>'action')::boolean,false) end;
    if jsonb_typeof(head) is distinct from 'object' or (head->>'action')::boolean is distinct from issued_action then
      raise exception 'v104 iteration shadow head action mismatch: %',head_key;
    end if;
    if not issued_action then
      if head->>'status' is distinct from 'no_action' or head->'isHit' <> 'null'::jsonb
         or (head->>'fixedStakeUnits')::numeric <> 0 or (head->>'weightedStakeUnits')::numeric <> 0
         or (head->>'fixedNetUnits')::numeric <> 0 or (head->>'weightedNetUnits')::numeric <> 0 then
        raise exception 'v104 iteration shadow no-action result mismatch: %',head_key;
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
       or (expected_head_status='push' and head->'isHit' <> 'null'::jsonb)
       or (expected_head_status='hit' and (head->>'isHit')::boolean is distinct from true)
       or (expected_head_status='miss' and (head->>'isHit')::boolean is distinct from false) then
      raise exception 'v104 iteration shadow head outcome mismatch: %',head_key;
    end if;
    fixed_stake := (head->>'fixedStakeUnits')::numeric;
    weighted_stake := (head->>'weightedStakeUnits')::numeric;
    fixed_net := (head->>'fixedNetUnits')::numeric;
    weighted_net := (head->>'weightedNetUnits')::numeric;
    issued_units := (issued_head->>'units')::numeric;
    if fixed_stake <> 1 or weighted_stake is distinct from issued_units
       or fixed_net is distinct from (case expected_head_status when 'push' then 0 when 'hit' then round(payout,3) else -1 end)
       or weighted_net is distinct from (case expected_head_status when 'push' then 0 when 'hit' then round(weighted_stake*payout,3) else round(-weighted_stake,3) end) then
      raise exception 'v104 iteration shadow payout mismatch: %',head_key;
    end if;
  end loop;

  select * into settled from public.v104_iteration_shadow_v3_settlements where prediction_id=issued.id;
  if settled.id is not null then
    if settled.actual_result is distinct from p_settlement->>'actual_result'
       or settled.actual_facts is distinct from p_settlement->'actual_facts'
       or settled.head_results is distinct from p_settlement->'head_results'
       or settled.settlement_source_action is distinct from p_settlement->>'settlement_source_action' then
      raise exception 'conflicting v104 iteration shadow settlement';
    end if;
    select * into counter from public.v104_iteration_shadow_v3_sequence_counters where release_candidate='v104.3.0-seven-head-shadow.3';
    return jsonb_build_object('prediction_id',issued.id,'persisted',true,'duplicate',true,
      'settlement_sequence',settled.settlement_sequence,'action_sequences',to_jsonb(counter)-'release_candidate'-'updated_at');
  end if;

  select * into counter from public.v104_iteration_shadow_v3_sequence_counters
    where release_candidate='v104.3.0-seven-head-shadow.3' for update;
  update public.v104_iteration_shadow_v3_sequence_counters set
    settlement_count=settlement_count+1,
    main_action_count=main_action_count+1,
    tie_action_count=tie_action_count+case when (p_settlement->'head_results'->'tie'->>'action')::boolean then 1 else 0 end,
    super_six_action_count=super_six_action_count+case when (p_settlement->'head_results'->'superSix'->>'action')::boolean then 1 else 0 end,
    banker_dragon_action_count=banker_dragon_action_count+case when (p_settlement->'head_results'->'bankerDragon'->>'action')::boolean then 1 else 0 end,
    player_dragon_action_count=player_dragon_action_count+case when (p_settlement->'head_results'->'playerDragon'->>'action')::boolean then 1 else 0 end,
    banker_pair_action_count=banker_pair_action_count+case when (p_settlement->'head_results'->'bankerPair'->>'action')::boolean then 1 else 0 end,
    player_pair_action_count=player_pair_action_count+case when (p_settlement->'head_results'->'playerPair'->>'action')::boolean then 1 else 0 end,
    updated_at=now()
    where release_candidate='v104.3.0-seven-head-shadow.3' returning * into counter;
  insert into public.v104_iteration_shadow_v3_settlements (
    settlement_sequence,prediction_id,source,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,actual_facts,is_hit,
    settlement_status,settlement_final,settlement_source_action,head_results,resolved_at
  ) values (
    counter.settlement_count,issued.id,issued.source,issued.table_id,issued.shoe_no,issued.round_no,issued.strategy_version,issued.predicted_result,
    p_settlement->>'actual_result',p_settlement->'actual_facts',nullif(p_settlement->>'is_hit','')::boolean,expected,true,
    p_settlement->>'settlement_source_action',p_settlement->'head_results',(p_settlement->>'resolved_at')::timestamptz
  ) returning * into settled;
  return jsonb_build_object('prediction_id',issued.id,'persisted',true,'duplicate',false,
    'settlement_sequence',settled.settlement_sequence,'action_sequences',to_jsonb(counter)-'release_candidate'-'updated_at');
end; $$;

create or replace function public.persist_v104_iteration_shadow_v3_artifacts(p_report jsonb, p_suggestions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare
  report_payload jsonb; report_svg text; cycle_no bigint; existing_report public.v104_iteration_shadow_v3_cycle_reports%rowtype;
  suggestion jsonb; existing_suggestion public.v104_iteration_shadow_v3_weight_suggestions%rowtype;
  head_key_value text; action_cycle_value bigint; sample_start bigint; sample_end bigint; persisted_suggestions integer:=0;
begin
  perform 1 from public.v104_iteration_shadow_v3_runtime_settings
    where release_candidate='v104.3.0-seven-head-shadow.3' and enabled=true and status='shadow' and active_strategy_version='v104'
    for share;
  if not found then
    raise exception 'v104 iteration shadow is disabled';
  end if;
  if p_report is not null and p_report <> 'null'::jsonb then
    report_payload := p_report->'report_payload'; report_svg := p_report->>'report_svg';
    cycle_no := (report_payload->>'cycleNumber')::bigint;
    if jsonb_typeof(report_payload) is distinct from 'object' or coalesce(report_svg,'') not like '<svg%'
       or (select count(*) from public.v104_iteration_shadow_v3_settlements where settlement_sequence between ((cycle_no-1)*1000+1) and cycle_no*1000) <> 1000 then
      raise exception 'v104 iteration shadow cycle report is incomplete';
    end if;
    insert into public.v104_iteration_shadow_v3_cycle_reports (
      cycle_number,start_sequence,end_sequence,model_version,report_payload,report_svg
    ) values (cycle_no,(cycle_no-1)*1000+1,cycle_no*1000,'v104-seven-head-shadow-v3-main-player-pair-reweight',report_payload,report_svg)
    on conflict (cycle_number) do nothing returning * into existing_report;
    if existing_report.id is null then
      select * into existing_report from public.v104_iteration_shadow_v3_cycle_reports where cycle_number=cycle_no;
      if existing_report.report_payload is distinct from report_payload or existing_report.report_svg is distinct from report_svg then
        raise exception 'conflicting v104 iteration shadow cycle report';
      end if;
    end if;
  end if;
  if p_suggestions is not null and jsonb_typeof(p_suggestions)='array' then
    for suggestion in select value from jsonb_array_elements(p_suggestions) loop
      head_key_value := suggestion->>'headKey'; action_cycle_value := (suggestion->>'actionCycle')::bigint;
      sample_start := (suggestion->>'sampleStartAction')::bigint; sample_end := (suggestion->>'sampleEndAction')::bigint;
      if head_key_value not in ('main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair')
         or suggestion->>'modelVersion' is distinct from 'v104-seven-head-shadow-v3-main-player-pair-reweight'
         or suggestion->>'searchMethod' is distinct from 'exhaustive_5_percent_grid'
         or suggestion->'autoApply' is distinct from 'false'::jsonb
         or sample_start <> ((action_cycle_value-1)*1000+1) or sample_end <> action_cycle_value*1000
         or (select count(*) from public.v104_iteration_shadow_v3_settlements where (head_results->head_key_value->>'action')::boolean) < sample_end
         or (select array_agg(key order by key) from jsonb_object_keys(suggestion->'currentWeights') key)
            is distinct from (select array_agg(key order by key) from jsonb_object_keys(suggestion->'suggestedWeights') key)
         or abs((select sum(value::numeric) from jsonb_each_text(suggestion->'suggestedWeights'))-1) > 0.000000001
         or exists (select 1 from jsonb_each_text(suggestion->'suggestedWeights') where mod(round(value::numeric*100),5)<>0 or value::numeric<0.05) then
        raise exception 'v104 iteration shadow suggestion contract mismatch';
      end if;
      insert into public.v104_iteration_shadow_v3_weight_suggestions (
        suggestion_id,head_key,action_cycle,sample_start_action,sample_end_action,model_version,search_method,
        current_weights,suggested_weights,baseline_metrics,candidate_metrics,status,auto_apply
      ) values (
        suggestion->>'id',head_key_value,action_cycle_value,sample_start,sample_end,'v104-seven-head-shadow-v3-main-player-pair-reweight','exhaustive_5_percent_grid',
        suggestion->'currentWeights',suggestion->'suggestedWeights',suggestion->'baselineMetrics',suggestion->'candidateMetrics','pending',false
      ) on conflict (head_key,action_cycle) do nothing returning * into existing_suggestion;
      if existing_suggestion.suggestion_id is null then
        select * into existing_suggestion from public.v104_iteration_shadow_v3_weight_suggestions
          where head_key=head_key_value and action_cycle=action_cycle_value;
        if existing_suggestion.current_weights is distinct from suggestion->'currentWeights'
           or existing_suggestion.suggested_weights is distinct from suggestion->'suggestedWeights'
           or existing_suggestion.baseline_metrics is distinct from suggestion->'baselineMetrics'
           or existing_suggestion.candidate_metrics is distinct from suggestion->'candidateMetrics' then
          raise exception 'conflicting v104 iteration shadow suggestion';
        end if;
      end if;
      persisted_suggestions := persisted_suggestions+1;
    end loop;
  end if;
  return jsonb_build_object('persisted',true,'cycle_number',cycle_no,'suggestions',persisted_suggestions);
end; $$;

create or replace function public.review_v104_iteration_shadow_v3_suggestion(p_suggestion_id text, p_decision text, p_reviewer text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare reviewed public.v104_iteration_shadow_v3_weight_suggestions%rowtype;
begin
  perform 1 from public.v104_iteration_shadow_v3_runtime_settings
    where release_candidate='v104.3.0-seven-head-shadow.3' and enabled=true and status='shadow' and active_strategy_version='v104'
    for share;
  if not found then
    raise exception 'v104 iteration shadow is disabled';
  end if;
  if p_decision not in ('approved','rejected') or nullif(p_reviewer,'') is null then
    raise exception 'invalid v104 iteration shadow review';
  end if;
  update public.v104_iteration_shadow_v3_weight_suggestions set status=p_decision,reviewed_by=p_reviewer,reviewed_at=now()
    where suggestion_id=p_suggestion_id and status='pending' and auto_apply=false returning * into reviewed;
  if reviewed.suggestion_id is null then raise exception 'v104 iteration shadow suggestion is unavailable or already reviewed'; end if;
  return jsonb_build_object('suggestion_id',reviewed.suggestion_id,'status',reviewed.status,'auto_apply',reviewed.auto_apply);
end; $$;

create or replace view public.v104_iteration_shadow_v3_history as
select i.id prediction_id,i.source,i.table_id,i.shoe_no,i.round_no,i.strategy_version,i.prediction_timing,
  i.prediction_issued_at,i.predicted_result,i.confidence,i.prediction_payload,i.same_side_streak,
  i.independent_support_count,i.shoe_bias_suppressed,i.lock_risk,s.settlement_sequence,s.actual_result,s.actual_facts,s.is_hit,s.settlement_status,
  coalesce(s.settlement_final,false) settlement_final,s.settlement_source_action,s.head_results,s.resolved_at,
  count(*) filter (where (s.head_results->'main'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) main_action_sequence,
  count(*) filter (where (s.head_results->'tie'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) tie_action_sequence,
  count(*) filter (where (s.head_results->'superSix'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) super_six_action_sequence,
  count(*) filter (where (s.head_results->'bankerDragon'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) banker_dragon_action_sequence,
  count(*) filter (where (s.head_results->'playerDragon'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) player_dragon_action_sequence,
  count(*) filter (where (s.head_results->'bankerPair'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) banker_pair_action_sequence,
  count(*) filter (where (s.head_results->'playerPair'->>'action')::boolean is true) over (order by s.settlement_sequence rows between unbounded preceding and current row) player_pair_action_sequence
from public.v104_iteration_shadow_v3_issuances i left join public.v104_iteration_shadow_v3_settlements s on s.prediction_id=i.id
where i.strategy_version='v104-seven-head-shadow-v3-main-player-pair-reweight' and i.prediction_timing='pre_result_context' and i.prediction_issued_at is not null;

revoke all on table public.v104_iteration_shadow_v3_history from public,anon,authenticated,service_role;
grant select on table public.v104_iteration_shadow_v3_history to service_role;

revoke all on function public.issue_v104_iteration_shadow_v3_prediction(jsonb) from public,anon,authenticated;
revoke all on function public.settle_v104_iteration_shadow_v3_prediction(jsonb) from public,anon,authenticated;
revoke all on function public.persist_v104_iteration_shadow_v3_artifacts(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.review_v104_iteration_shadow_v3_suggestion(text,text,text) from public,anon,authenticated;
grant execute on function public.issue_v104_iteration_shadow_v3_prediction(jsonb) to service_role;
grant execute on function public.settle_v104_iteration_shadow_v3_prediction(jsonb) to service_role;
grant execute on function public.persist_v104_iteration_shadow_v3_artifacts(jsonb,jsonb) to service_role;
grant execute on function public.review_v104_iteration_shadow_v3_suggestion(text,text,text) to service_role;

commit;
