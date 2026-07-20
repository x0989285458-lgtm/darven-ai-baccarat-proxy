-- v103.0.0-shadow.1 additive shadow schema. Apply after the active v102 schema.
begin;

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v102') then
    raise exception 'v102 must remain the only Active strategy for v103 shadow';
  end if;
end;
$$;

create table if not exists public.v103_shadow_runtime_settings (
  release_candidate text primary key,
  strategy_version text not null check (strategy_version = 'v103'),
  status text not null check (status in ('shadow', 'shadow_disabled')),
  enabled boolean not null,
  active_strategy_version text not null check (active_strategy_version = 'v102'),
  updated_at timestamptz not null default now()
);

create table if not exists public.v103_shadow_issuances (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  table_id text not null,
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v103'),
  prediction_timing text not null check (prediction_timing = 'pre_result_context'),
  prediction_issued_at timestamptz not null default now(),
  predicted_result text not null check (predicted_result in ('banker', 'player')),
  confidence integer not null check (confidence between 0 and 100),
  feature_weights jsonb not null,
  score_sources jsonb not null,
  score_totals jsonb not null,
  calibration jsonb not null,
  prediction_payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint v103_shadow_issuance_identity_unique unique (source, table_id, shoe_no, round_no, strategy_version)
);

create table if not exists public.v103_shadow_settlements (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null unique references public.v103_shadow_issuances(id),
  source text not null,
  table_id text not null,
  shoe_no text not null,
  round_no integer not null check (round_no > 0),
  strategy_version text not null check (strategy_version = 'v103'),
  predicted_result text not null check (predicted_result in ('banker', 'player')),
  actual_result text not null check (actual_result in ('banker', 'player', 'tie')),
  is_hit boolean,
  settlement_status text not null check (settlement_status in ('hit', 'miss', 'push')),
  settlement_final boolean not null check (settlement_final = true),
  settlement_source_action text not null,
  resolved_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint v103_shadow_push_semantics check (
    (actual_result = 'tie' and settlement_status = 'push' and is_hit is null)
    or (actual_result <> 'tie' and settlement_status in ('hit', 'miss') and is_hit is not null)
  )
);

alter table public.v103_shadow_runtime_settings enable row level security;
alter table public.v103_shadow_issuances enable row level security;
alter table public.v103_shadow_settlements enable row level security;

revoke all on table public.v103_shadow_runtime_settings from public, anon, authenticated;
revoke all on table public.v103_shadow_issuances from public, anon, authenticated;
revoke all on table public.v103_shadow_settlements from public, anon, authenticated;
revoke all on table public.v103_shadow_runtime_settings from service_role;
revoke all on table public.v103_shadow_issuances from service_role;
revoke all on table public.v103_shadow_settlements from service_role;
grant select on table public.v103_shadow_runtime_settings to service_role;
grant select on table public.v103_shadow_issuances to service_role;
grant select on table public.v103_shadow_settlements to service_role;

insert into public.v103_shadow_runtime_settings (
  release_candidate, strategy_version, status, enabled, active_strategy_version, updated_at
) values ('v103.0.0-shadow.1', 'v103', 'shadow', true, 'v102', now())
on conflict (release_candidate) do update set
  strategy_version = excluded.strategy_version,
  status = 'shadow',
  enabled = true,
  active_strategy_version = 'v102',
  updated_at = now();

create or replace function public.issue_v103_shadow_prediction(p_prediction jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  issued public.v103_shadow_issuances%rowtype;
  inserted boolean := false;
begin
  if not exists (
    select 1 from public.v103_shadow_runtime_settings
    where release_candidate = 'v103.0.0-shadow.1' and enabled = true and status = 'shadow' and active_strategy_version = 'v102'
  ) then raise exception 'v103 shadow is disabled'; end if;
  if nullif(p_prediction->>'source', '') is null
     or nullif(p_prediction->>'table_id', '') is null
     or nullif(p_prediction->>'shoe_no', '') is null
     or coalesce((p_prediction->>'round_no')::integer, 0) < 1
     or p_prediction->>'strategy_version' is distinct from 'v103'
     or p_prediction->>'prediction_timing' is distinct from 'pre_result_context'
     or p_prediction->>'predicted_result' not in ('banker', 'player')
     or jsonb_typeof(p_prediction->'prediction_payload') is distinct from 'object'
     or p_prediction->'prediction_payload'->>'strategyVersion' is distinct from 'v103'
     or p_prediction->'prediction_payload'->>'predictionTiming' is distinct from 'pre_result_context'
     or p_prediction->'prediction_payload'->'shadowOnly' is distinct from 'true'::jsonb
     or p_prediction->'prediction_payload'->'activationEligible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'memberVisible' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->'writesSideActions' is distinct from 'false'::jsonb
     or p_prediction->'prediction_payload'->>'source' is distinct from p_prediction->>'source'
     or p_prediction->'prediction_payload'->>'targetTableId' is distinct from p_prediction->>'table_id'
     or p_prediction->'prediction_payload'->>'targetShoe' is distinct from p_prediction->>'shoe_no'
     or (p_prediction->'prediction_payload'->>'targetRound')::integer is distinct from (p_prediction->>'round_no')::integer
     or p_prediction->'prediction_payload'->>'predictedResult' is distinct from p_prediction->>'predicted_result'
     or p_prediction->'feature_weights' is distinct from jsonb_build_object(
       'roadmap_trend_signals', 0.05, 'ask_road_signals', 0.05,
       'recent_practical_calibration', 0.45, 'shoe_banker_player_bias', 0.35,
       'neutral_reserve', 0.10
     ) then
    raise exception 'v103 shadow issuance payload is incomplete';
  end if;

  insert into public.v103_shadow_issuances (
    source, table_id, shoe_no, round_no, strategy_version, prediction_timing,
    predicted_result, confidence, feature_weights, score_sources, score_totals, calibration, prediction_payload
  ) values (
    p_prediction->>'source', p_prediction->>'table_id', p_prediction->>'shoe_no', (p_prediction->>'round_no')::integer,
    'v103', 'pre_result_context', p_prediction->>'predicted_result', (p_prediction->>'confidence')::integer,
    p_prediction->'feature_weights', p_prediction->'score_sources', p_prediction->'score_totals',
    p_prediction->'calibration', p_prediction->'prediction_payload'
  ) on conflict (source, table_id, shoe_no, round_no, strategy_version) do nothing
  returning * into issued;
  inserted := issued.id is not null;

  if not inserted then
    select * into issued from public.v103_shadow_issuances
    where source = p_prediction->>'source' and table_id = p_prediction->>'table_id'
      and shoe_no = p_prediction->>'shoe_no' and round_no = (p_prediction->>'round_no')::integer
      and strategy_version = 'v103';
    if issued.id is null
       or issued.prediction_timing is distinct from 'pre_result_context'
       or issued.predicted_result is distinct from p_prediction->>'predicted_result'
       or issued.confidence is distinct from (p_prediction->>'confidence')::integer
       or issued.feature_weights is distinct from p_prediction->'feature_weights'
       or issued.score_sources is distinct from p_prediction->'score_sources'
       or issued.score_totals is distinct from p_prediction->'score_totals'
       or issued.calibration is distinct from p_prediction->'calibration'
       or issued.prediction_payload is distinct from p_prediction->'prediction_payload' then
      raise exception 'conflicting v103 shadow issuance';
    end if;
  end if;

  return jsonb_build_object(
    'prediction_id', issued.id,
    'prediction_issued_at', issued.prediction_issued_at,
    'prediction', issued.prediction_payload,
    'duplicate', not inserted
  );
end;
$$;

create or replace function public.settle_v103_shadow_prediction(p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  issued public.v103_shadow_issuances%rowtype;
  settled public.v103_shadow_settlements%rowtype;
  inserted boolean := false;
  expected_status text;
begin
  if not exists (
    select 1 from public.v103_shadow_runtime_settings
    where release_candidate = 'v103.0.0-shadow.1' and enabled = true and status = 'shadow' and active_strategy_version = 'v102'
  ) then raise exception 'v103 shadow is disabled'; end if;
  if coalesce(p_settlement->>'settlement_source_action', '') not in (
    'summary', '/summary', '/api/v1/gametype/*/game/*/room/*/table/*/summary',
    'show_win', '/show_win', '/api/v1/gametype/*/game/*/room/*/table/*/show_win'
  ) then
    raise exception 'v103 shadow settlement requires verified Final summary/show_win; show_poker is provisional';
  end if;

  select * into issued from public.v103_shadow_issuances
  where id = (p_settlement->>'prediction_id')::uuid for update;
  if issued.id is null
     or issued.source is distinct from p_settlement->>'source'
     or issued.table_id is distinct from p_settlement->>'table_id'
     or issued.shoe_no is distinct from p_settlement->>'shoe_no'
     or issued.round_no is distinct from (p_settlement->>'round_no')::integer
     or issued.strategy_version is distinct from p_settlement->>'strategy_version'
     or issued.predicted_result is distinct from p_settlement->>'predicted_result'
     or issued.prediction_timing is distinct from 'pre_result_context'
     or issued.prediction_issued_at is null
     or coalesce((p_settlement->>'settlement_final')::boolean, false) is not true
     or p_settlement->>'actual_result' not in ('banker', 'player', 'tie') then
    raise exception 'v103 shadow settlement identity mismatch';
  end if;

  expected_status := case when p_settlement->>'actual_result' = 'tie' then 'push'
    when p_settlement->>'actual_result' = issued.predicted_result then 'hit' else 'miss' end;
  if p_settlement->>'settlement_status' is distinct from expected_status
     or (expected_status = 'push' and p_settlement->'is_hit' <> 'null'::jsonb)
     or (expected_status <> 'push' and (p_settlement->>'is_hit')::boolean is distinct from (expected_status = 'hit')) then
    raise exception 'v103 shadow settlement outcome is inconsistent';
  end if;

  insert into public.v103_shadow_settlements (
    prediction_id, source, table_id, shoe_no, round_no, strategy_version, predicted_result,
    actual_result, is_hit, settlement_status, settlement_final, settlement_source_action, resolved_at
  ) values (
    issued.id, issued.source, issued.table_id, issued.shoe_no, issued.round_no, issued.strategy_version, issued.predicted_result,
    p_settlement->>'actual_result', nullif(p_settlement->>'is_hit', '')::boolean, expected_status, true,
    p_settlement->>'settlement_source_action', (p_settlement->>'resolved_at')::timestamptz
  ) on conflict (prediction_id) do nothing returning * into settled;
  inserted := settled.id is not null;

  if not inserted then
    select * into settled from public.v103_shadow_settlements where prediction_id = issued.id;
    if settled.actual_result is distinct from p_settlement->>'actual_result'
       or settled.is_hit is distinct from nullif(p_settlement->>'is_hit', '')::boolean
       or settled.settlement_status is distinct from expected_status
       or settled.settlement_source_action is distinct from p_settlement->>'settlement_source_action' then
      raise exception 'conflicting v103 shadow settlement';
    end if;
  end if;

  return jsonb_build_object('prediction_id', issued.id, 'persisted', true, 'duplicate', not inserted);
end;
$$;

create or replace view public.v103_shadow_history as
select
  i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
  i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
  s.actual_result, s.is_hit, s.settlement_status, s.settlement_final, s.settlement_source_action, s.resolved_at
from public.v103_shadow_issuances i
join public.v103_shadow_settlements s on s.prediction_id = i.id
where i.strategy_version = 'v103' and i.prediction_timing = 'pre_result_context'
  and i.prediction_issued_at is not null and s.settlement_final = true;

revoke all on table public.v103_shadow_history from public, anon, authenticated;
grant select on table public.v103_shadow_history to service_role;

create or replace function public.get_v103_shadow_history(p_limit integer default 10000)
returns setof public.v103_shadow_history
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  select * from public.v103_shadow_history
  order by resolved_at desc
  limit least(10000, greatest(1, coalesce(p_limit, 10000)));
$$;

revoke all on function public.issue_v103_shadow_prediction(jsonb) from public, anon, authenticated;
revoke all on function public.settle_v103_shadow_prediction(jsonb) from public, anon, authenticated;
revoke all on function public.get_v103_shadow_history(integer) from public, anon, authenticated;
grant execute on function public.issue_v103_shadow_prediction(jsonb) to service_role;
grant execute on function public.settle_v103_shadow_prediction(jsonb) to service_role;
grant execute on function public.get_v103_shadow_history(integer) to service_role;

commit;
