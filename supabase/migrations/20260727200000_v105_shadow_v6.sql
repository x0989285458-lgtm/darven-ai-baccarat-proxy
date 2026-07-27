-- v105-shadow-v6-road-pattern: backend-only shadow persistence, isolated from every prior shadow version.
begin;

create table if not exists public.v105_shadow_v6_runtime_settings (
  release_candidate text primary key,
  strategy_version text not null check (strategy_version = 'v105-shadow-v6-road-pattern'),
  status text not null check (status in ('shadow','shadow_disabled')),
  enabled boolean not null,
  active_strategy_version text not null check (active_strategy_version = 'v105'),
  updated_at timestamptz not null default now()
);

create table if not exists public.v105_shadow_v6_sequence_counters (
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

create table if not exists public.v105_shadow_v6_issuances (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  table_id text not null check (table_id in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')),
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v105-shadow-v6-road-pattern'),
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
  constraint v105_shadow_v6_issuance_identity_unique unique (source,table_id,shoe_no,round_no,strategy_version)
);

create table if not exists public.v105_shadow_v6_settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_sequence bigint not null unique check (settlement_sequence > 0),
  main_action_sequence bigint unique,
  tie_action_sequence bigint unique,
  super_six_action_sequence bigint unique,
  banker_dragon_action_sequence bigint unique,
  player_dragon_action_sequence bigint unique,
  banker_pair_action_sequence bigint unique,
  player_pair_action_sequence bigint unique,
  prediction_id uuid not null unique references public.v105_shadow_v6_issuances(id),
  source text not null,
  table_id text not null check (table_id in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')),
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v105-shadow-v6-road-pattern'),
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
  constraint v105_shadow_v6_main_semantics check (
    (actual_result='tie' and settlement_status='push' and is_hit is null)
    or (actual_result<>'tie' and settlement_status in ('hit','miss') and is_hit is not null)
  )
);

create index if not exists v105_shadow_v6_issuances_issued_idx
  on public.v105_shadow_v6_issuances (prediction_issued_at desc,id desc);
create index if not exists v105_shadow_v6_settlements_resolved_idx
  on public.v105_shadow_v6_settlements (resolved_at desc,prediction_id);

alter table public.v105_shadow_v6_runtime_settings enable row level security;
alter table public.v105_shadow_v6_sequence_counters enable row level security;
alter table public.v105_shadow_v6_issuances enable row level security;
alter table public.v105_shadow_v6_settlements enable row level security;

revoke all on table public.v105_shadow_v6_runtime_settings from public,anon,authenticated,service_role;
revoke all on table public.v105_shadow_v6_sequence_counters from public,anon,authenticated,service_role;
revoke all on table public.v105_shadow_v6_issuances from public,anon,authenticated,service_role;
revoke all on table public.v105_shadow_v6_settlements from public,anon,authenticated,service_role;
grant select on table public.v105_shadow_v6_runtime_settings to service_role;
grant select on table public.v105_shadow_v6_sequence_counters to service_role;
grant select on table public.v105_shadow_v6_issuances to service_role;
grant select on table public.v105_shadow_v6_settlements to service_role;

insert into public.v105_shadow_v6_runtime_settings (
  release_candidate,strategy_version,status,enabled,active_strategy_version,updated_at
) values ('v105-shadow-v6-road-pattern','v105-shadow-v6-road-pattern','shadow',true,'v105',now())
on conflict (release_candidate) do nothing;

insert into public.v105_shadow_v6_sequence_counters (release_candidate,settlement_count)
values ('v105-shadow-v6-road-pattern',0)
on conflict (release_candidate) do nothing;

create or replace function public.issue_v105_shadow_v6_prediction(p_prediction jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $$
declare
  issued public.v105_shadow_v6_issuances%rowtype;
begin
  perform 1 from public.ai_strategy_versions where status='active' and version='v105';
  if not found or (select count(*) from public.ai_strategy_versions where status='active') <> 1 then
    raise exception 'v105 Active strategy verification failed';
  end if;
  perform 1 from public.v105_shadow_v6_runtime_settings
    where release_candidate='v105-shadow-v6-road-pattern' and strategy_version='v105-shadow-v6-road-pattern'
      and status='shadow' and enabled=true and active_strategy_version='v105'
    for share;
  if not found then raise exception 'v105-shadow-v6-road-pattern is disabled'; end if;

  if nullif(p_prediction->>'source','') is null
     or nullif(p_prediction->>'table_id','') is null
     or p_prediction->>'table_id' not in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10')
     or nullif(p_prediction->>'shoe_no','') is null
     or coalesce((p_prediction->>'round_no')::integer,0) < 1
     or p_prediction->>'strategy_version' is distinct from 'v105-shadow-v6-road-pattern'
     or p_prediction->>'prediction_timing' is distinct from 'pre_result_context'
     or p_prediction->>'predicted_result' not in ('banker','player')
     or coalesce((p_prediction->>'confidence')::numeric,-1) not between 0 and 100
     or coalesce((p_prediction->>'same_side_streak')::integer,0) < 1
     or jsonb_typeof(p_prediction->'prediction_payload') is distinct from 'object'
     or p_prediction->'prediction_payload'->>'strategyVersion' is distinct from 'v105-shadow-v6-road-pattern'
     or p_prediction->'prediction_payload'->>'releaseCandidate' is distinct from 'v105-shadow-v6-road-pattern'
     or p_prediction->'prediction_payload'->>'formalStrategyVersion' is distinct from 'v105'
     or p_prediction->'prediction_payload'->>'predictionTiming' is distinct from 'pre_result_context'
     or p_prediction->'prediction_payload'->'shadowOnly' is distinct from 'true'::jsonb
     or p_prediction->'prediction_payload'->'activationEligible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'memberVisible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'writesSideActions' is distinct from 'false'::jsonb
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternSignal') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'decodedRecentRuns') is distinct from 'array'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows') is distinct from 'object'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows'->'near6') is distinct from 'array'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows'->'near12') is distinct from 'array'
     or jsonb_typeof(p_prediction->'prediction_payload'->'roadPatternWindows'->'background24') is distinct from 'array'
     or p_prediction->'prediction_payload'->>'predictedResult' is distinct from p_prediction->>'predicted_result'
     or (p_prediction->'prediction_payload'->>'confidence')::numeric is distinct from (p_prediction->>'confidence')::numeric
     or (p_prediction->'prediction_payload'->>'sameSideStreak')::integer is distinct from (p_prediction->>'same_side_streak')::integer
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
    raise exception 'v105-shadow-v6-road-pattern issuance payload is invalid';
  end if;

  insert into public.v105_shadow_v6_issuances (
    source,table_id,shoe_no,round_no,strategy_version,prediction_timing,predicted_result,
    confidence,same_side_streak,independent_support_count,shoe_bias_suppressed,lock_risk,prediction_payload
  ) values (
    p_prediction->>'source',p_prediction->>'table_id',p_prediction->>'shoe_no',(p_prediction->>'round_no')::integer,
    p_prediction->>'strategy_version',p_prediction->>'prediction_timing',p_prediction->>'predicted_result',
    (p_prediction->>'confidence')::numeric,(p_prediction->>'same_side_streak')::integer,
    (p_prediction->>'independent_support_count')::integer,(p_prediction->>'shoe_bias_suppressed')::boolean,
    (p_prediction->>'lock_risk')::boolean,p_prediction->'prediction_payload'
  ) on conflict (source,table_id,shoe_no,round_no,strategy_version) do nothing;

  select * into issued from public.v105_shadow_v6_issuances
  where source=p_prediction->>'source' and table_id=p_prediction->>'table_id'
    and shoe_no=p_prediction->>'shoe_no' and round_no=(p_prediction->>'round_no')::integer
    and strategy_version='v105-shadow-v6-road-pattern';
  if not found or issued.prediction_payload is distinct from p_prediction->'prediction_payload' then
    raise exception 'conflicting v105-shadow-v6-road-pattern issuance';
  end if;
  return jsonb_build_object('prediction_id',issued.id,'prediction_issued_at',issued.prediction_issued_at,'prediction',issued.prediction_payload);
end;
$$;

create or replace function public.settle_v105_shadow_v6_prediction(p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $$
declare
  issued public.v105_shadow_v6_issuances%rowtype;
  existing public.v105_shadow_v6_settlements%rowtype;
  counters public.v105_shadow_v6_sequence_counters%rowtype;
  next_sequence bigint;
begin
  if p_settlement->>'strategy_version' is distinct from 'v105-shadow-v6-road-pattern'
     or p_settlement->'settlement_final' is distinct from 'true'::jsonb
     or p_settlement->>'settlement_source_action' not in ('summary','show_win')
     or p_settlement->>'actual_result' not in ('banker','player','tie')
     or jsonb_typeof(p_settlement->'actual_facts') is distinct from 'object'
     or jsonb_typeof(p_settlement->'head_results') is distinct from 'object' then
    raise exception 'v105-shadow-v6-road-pattern settlement payload is invalid';
  end if;
  select * into issued from public.v105_shadow_v6_issuances
    where id=(p_settlement->>'prediction_id')::uuid for share;
  if not found
     or issued.strategy_version <> 'v105-shadow-v6-road-pattern'
     or issued.source is distinct from p_settlement->>'source'
     or issued.table_id is distinct from p_settlement->>'table_id'
     or issued.shoe_no is distinct from p_settlement->>'shoe_no'
     or issued.round_no is distinct from (p_settlement->>'round_no')::integer
     or issued.predicted_result is distinct from p_settlement->>'predicted_result' then
    raise exception 'v105-shadow-v6-road-pattern settlement identity mismatch';
  end if;

  select * into existing from public.v105_shadow_v6_settlements where prediction_id=issued.id;
  if found then
    if existing.actual_result is distinct from p_settlement->>'actual_result'
       or existing.actual_facts is distinct from p_settlement->'actual_facts'
       or existing.head_results is distinct from p_settlement->'head_results'
       or existing.settlement_status is distinct from p_settlement->>'settlement_status'
       or existing.settlement_source_action is distinct from p_settlement->>'settlement_source_action'
       or existing.is_hit is distinct from (p_settlement->>'is_hit')::boolean
       or existing.resolved_at is distinct from (p_settlement->>'resolved_at')::timestamptz then
      raise exception 'conflicting v105-shadow-v6-road-pattern settlement';
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

  select * into counters from public.v105_shadow_v6_sequence_counters
    where release_candidate='v105-shadow-v6-road-pattern' for update;
  if not found then raise exception 'v105-shadow-v6-road-pattern sequence counter is unavailable'; end if;
  next_sequence := counters.settlement_count + 1;
  insert into public.v105_shadow_v6_settlements (
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
  update public.v105_shadow_v6_sequence_counters
    set settlement_count=next_sequence,
      main_action_count=main_action_count+case when (issued.prediction_payload->'heads'->'main'->>'action')::boolean then 1 else 0 end,
      tie_action_count=tie_action_count+case when (issued.prediction_payload->'heads'->'tie'->>'action')::boolean then 1 else 0 end,
      super_six_action_count=super_six_action_count+case when (issued.prediction_payload->'heads'->'superSix'->>'action')::boolean then 1 else 0 end,
      banker_dragon_action_count=banker_dragon_action_count+case when (issued.prediction_payload->'heads'->'bankerDragon'->>'action')::boolean then 1 else 0 end,
      player_dragon_action_count=player_dragon_action_count+case when (issued.prediction_payload->'heads'->'playerDragon'->>'action')::boolean then 1 else 0 end,
      banker_pair_action_count=banker_pair_action_count+case when (issued.prediction_payload->'heads'->'bankerPair'->>'action')::boolean then 1 else 0 end,
      player_pair_action_count=player_pair_action_count+case when (issued.prediction_payload->'heads'->'playerPair'->>'action')::boolean then 1 else 0 end,
      updated_at=now()
    where release_candidate='v105-shadow-v6-road-pattern'
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

create or replace view public.v105_shadow_v6_history
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
from public.v105_shadow_v6_issuances i
left join public.v105_shadow_v6_settlements s on s.prediction_id=i.id;

revoke all on function public.issue_v105_shadow_v6_prediction(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.settle_v105_shadow_v6_prediction(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.issue_v105_shadow_v6_prediction(jsonb) to service_role;
grant execute on function public.settle_v105_shadow_v6_prediction(jsonb) to service_role;
revoke all on public.v105_shadow_v6_history from public,anon,authenticated,service_role;
grant select on public.v105_shadow_v6_history to service_role;

commit;
