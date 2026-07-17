-- v098.23: additive prediction issuance lifecycle classification.
-- Apply with service/admin privileges after reviewing the SELECT-only dry-run.

alter table public.daily_prediction_results
  add column if not exists prediction_issued_at timestamptz,
  add column if not exists issued_prediction_payload jsonb,
  add column if not exists settlement_final boolean,
  add column if not exists settlement_source_action text,
  add column if not exists side_actual_results jsonb,
  add column if not exists side_hits jsonb,
  add column if not exists settlement_status text,
  add column if not exists issuance_status text,
  add column if not exists issuance_status_updated_at timestamptz,
  add column if not exists issuance_status_reason text;

alter table public.daily_prediction_results
  drop constraint if exists daily_prediction_results_v09823_issuance_status_check;
alter table public.daily_prediction_results
  add constraint daily_prediction_results_v09823_issuance_status_check
  check (issuance_status is null or issuance_status in ('pending', 'settled', 'expired_no_final', 'abandoned_shoe_change'));

alter table public.daily_prediction_results
  drop constraint if exists daily_prediction_results_v09821_settlement_status_check;
alter table public.daily_prediction_results
  add constraint daily_prediction_results_v09821_settlement_status_check
  check (settlement_status is null or settlement_status in ('hit', 'miss', 'push', 'unknown'));

create index if not exists idx_daily_prediction_results_prediction_issued_at
  on public.daily_prediction_results(prediction_issued_at desc)
  where prediction_issued_at is not null;

create or replace function public.issue_v09821_prediction(p_prediction jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  issued public.daily_prediction_results%rowtype;
begin
  if nullif(p_prediction->>'source', '') is null
     or nullif(p_prediction->>'table_id', '') is null
     or nullif(p_prediction->>'shoe_no', '') is null
     or nullif(p_prediction->>'round_no', '') is null
     or nullif(p_prediction->>'strategy_version', '') is null
     or nullif(p_prediction->>'predicted_result', '') is null
     or p_prediction->>'predicted_result' not in ('banker', 'player')
     or jsonb_typeof(p_prediction->'issued_prediction_payload') <> 'object'
     or p_prediction->'issued_prediction_payload'->>'targetTableId' is distinct from p_prediction->>'table_id'
     or p_prediction->'issued_prediction_payload'->>'targetShoe' is distinct from p_prediction->>'shoe_no'
     or (p_prediction->'issued_prediction_payload'->>'targetRound')::integer is distinct from (p_prediction->>'round_no')::integer
     or p_prediction->'issued_prediction_payload'->>'strategyVersion' is distinct from p_prediction->>'strategy_version'
     or p_prediction->'issued_prediction_payload'->>'predictedResult' is distinct from p_prediction->>'predicted_result'
     or (p_prediction->'issued_prediction_payload'->>'confidence')::integer is distinct from (p_prediction->>'confidence')::integer then
    raise exception 'prediction issuance payload is incomplete';
  end if;

  insert into public.daily_prediction_results (
    source, table_id, shoe_no, round_no, strategy_version,
    predicted_result, confidence, actual_result, is_hit,
    table_recent_hit_rate, table_recent_prediction_count, short_run_adjustment,
    prediction_features, probabilities, resolved_at,
    prediction_issued_at, issued_prediction_payload, settlement_final, settlement_status,
    issuance_status, issuance_status_updated_at, issuance_status_reason
  ) values (
    p_prediction->>'source', p_prediction->>'table_id', p_prediction->>'shoe_no', (p_prediction->>'round_no')::integer,
    p_prediction->>'strategy_version', p_prediction->>'predicted_result', (p_prediction->>'confidence')::integer,
    null, null,
    nullif(p_prediction->>'table_recent_hit_rate', '')::numeric,
    nullif(p_prediction->>'table_recent_prediction_count', '')::integer,
    coalesce(p_prediction->'short_run_adjustment', '{}'::jsonb),
    coalesce(p_prediction->'prediction_features', '{}'::jsonb),
    coalesce(p_prediction->'probabilities', '{}'::jsonb),
    null,
    now(), p_prediction->'issued_prediction_payload', false, 'unknown',
    'pending', now(), 'issued_before_authoritative_final'
  )
  on conflict (source, table_id, shoe_no, round_no, strategy_version) do nothing
  returning * into issued;

  if issued.id is null then
    select * into issued
    from public.daily_prediction_results
    where source = p_prediction->>'source'
      and table_id = p_prediction->>'table_id'
      and shoe_no = p_prediction->>'shoe_no'
      and round_no = (p_prediction->>'round_no')::integer
      and strategy_version = p_prediction->>'strategy_version'
    order by created_at, id
    limit 1;
  end if;

  if issued.id is null or issued.prediction_issued_at is null or issued.issued_prediction_payload is null then
    raise exception 'prediction identity conflicts with legacy row without immutable issuance evidence';
  end if;

  return jsonb_build_object(
    'prediction_id', issued.id,
    'prediction_issued_at', issued.prediction_issued_at,
    'prediction', issued.issued_prediction_payload || jsonb_build_object(
      'predictionId', issued.id,
      'issuedAt', issued.prediction_issued_at
    )
  );
end;
$$;

create or replace function public.settle_v09821_prediction(p_roadmap jsonb, p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.daily_prediction_results%rowtype;
  roadmap_written integer := 0;
  wanted_status text;
  already_settled boolean := false;
begin
  select * into existing
  from public.daily_prediction_results
  where id = (p_settlement->>'prediction_id')::uuid
  for update;

  if existing.id is null
     or existing.source is distinct from p_settlement->>'source'
     or existing.table_id is distinct from p_settlement->>'table_id'
     or existing.shoe_no is distinct from p_settlement->>'shoe_no'
     or existing.round_no is distinct from (p_settlement->>'round_no')::integer
     or existing.strategy_version is distinct from p_settlement->>'strategy_version'
     or p_roadmap->>'source' is distinct from existing.source
     or p_roadmap->>'table_id' is distinct from existing.table_id
     or p_roadmap->>'shoe_no' is distinct from existing.shoe_no
     or (p_roadmap->>'round_no')::integer is distinct from existing.round_no
     or p_roadmap->>'main_result' is distinct from p_settlement->>'actual_result' then
    raise exception 'settlement identity mismatch';
  end if;
  if existing.prediction_issued_at is null or existing.issued_prediction_payload is null then
    raise exception 'prediction has no immutable pre-result evidence';
  end if;
  if (p_settlement->>'actual_result') not in ('banker', 'player', 'tie')
     or jsonb_typeof(p_settlement->'is_hit') <> 'boolean'
     or nullif(p_settlement->>'resolved_at', '') is null
     or (p_settlement->>'is_hit')::boolean is distinct from (
       case
         when p_settlement->>'actual_result' = 'tie' then false
         else (p_settlement->>'actual_result' = existing.predicted_result)
       end
     )
     or coalesce((p_settlement->>'settlement_final')::boolean, false) is not true then
    raise exception 'settlement payload is incomplete';
  end if;

  wanted_status := case
    when p_settlement->>'actual_result' = 'tie' then 'push'
    when (p_settlement->>'is_hit')::boolean then 'hit'
    else 'miss'
  end;

  if existing.settlement_final is true then
    if existing.actual_result is distinct from p_settlement->>'actual_result'
       or existing.is_hit is distinct from (p_settlement->>'is_hit')::boolean
       or existing.settlement_source_action is distinct from p_settlement->>'settlement_source_action'
       or existing.side_actual_results is distinct from coalesce(p_settlement->'side_actual_results', '{}'::jsonb)
       or existing.side_hits is distinct from coalesce(p_settlement->'side_hits', '{}'::jsonb)
       or existing.settlement_status is distinct from wanted_status then
      raise exception 'conflicting existing prediction settlement';
    end if;
    already_settled := true;
  end if;

  insert into public.daily_roadmap_events (
    source, table_id, shoe_no, round_no, main_result,
    banker_points, player_points, banker_pair, player_pair, super_six,
    banker_dragon, player_dragon, bead_code, raw_event,
    player_card_codes, banker_card_codes, player_card_points, banker_card_points,
    player_card_ranks, banker_card_ranks, player_card_faces, banker_card_faces,
    player_drew, banker_drew, player_natural, banker_natural,
    remaining_rank_counts, remaining_point_counts
  ) values (
    p_roadmap->>'source', p_roadmap->>'table_id', p_roadmap->>'shoe_no', (p_roadmap->>'round_no')::integer, p_roadmap->>'main_result',
    nullif(p_roadmap->>'banker_points', '')::integer, nullif(p_roadmap->>'player_points', '')::integer,
    coalesce((p_roadmap->>'banker_pair')::boolean, false), coalesce((p_roadmap->>'player_pair')::boolean, false), coalesce((p_roadmap->>'super_six')::boolean, false),
    coalesce((p_roadmap->>'banker_dragon')::boolean, false), coalesce((p_roadmap->>'player_dragon')::boolean, false),
    p_roadmap->>'bead_code', coalesce(p_roadmap->'raw_event', '{}'::jsonb),
    coalesce(p_roadmap->'player_card_codes', '[]'::jsonb), coalesce(p_roadmap->'banker_card_codes', '[]'::jsonb),
    coalesce(p_roadmap->'player_card_points', '[]'::jsonb), coalesce(p_roadmap->'banker_card_points', '[]'::jsonb),
    coalesce(p_roadmap->'player_card_ranks', '[]'::jsonb), coalesce(p_roadmap->'banker_card_ranks', '[]'::jsonb),
    coalesce(p_roadmap->'player_card_faces', '[]'::jsonb), coalesce(p_roadmap->'banker_card_faces', '[]'::jsonb),
    coalesce((p_roadmap->>'player_drew')::boolean, false), coalesce((p_roadmap->>'banker_drew')::boolean, false),
    coalesce((p_roadmap->>'player_natural')::boolean, false), coalesce((p_roadmap->>'banker_natural')::boolean, false),
    coalesce(p_roadmap->'remaining_rank_counts', '{}'::jsonb), coalesce(p_roadmap->'remaining_point_counts', '{}'::jsonb)
  )
  on conflict (source, table_id, shoe_no, round_no) do update
    set source = excluded.source
    where (to_jsonb(daily_roadmap_events) - 'id' - 'opened_at' - 'created_at' - 'updated_at')
      = (to_jsonb(excluded) - 'id' - 'opened_at' - 'created_at' - 'updated_at');
  get diagnostics roadmap_written = row_count;
  if roadmap_written <> 1 then raise exception 'conflicting existing roadmap settlement'; end if;

  if already_settled then
    return jsonb_build_object('persisted', true, 'predictionDurable', true, 'roadmapDurable', true, 'prediction_id', existing.id, 'duplicate', true);
  end if;

  update public.daily_prediction_results
  set actual_result = p_settlement->>'actual_result',
      is_hit = (p_settlement->>'is_hit')::boolean,
      resolved_at = (p_settlement->>'resolved_at')::timestamptz,
      settlement_final = true,
      settlement_source_action = p_settlement->>'settlement_source_action',
      side_actual_results = coalesce(p_settlement->'side_actual_results', '{}'::jsonb),
      side_hits = coalesce(p_settlement->'side_hits', '{}'::jsonb),
      settlement_status = wanted_status,
      issuance_status = 'settled',
      issuance_status_updated_at = now(),
      issuance_status_reason = 'authoritative_final_received'
  where id = (p_settlement->>'prediction_id')::uuid;

  return jsonb_build_object('persisted', true, 'predictionDurable', true, 'roadmapDurable', true, 'prediction_id', existing.id, 'duplicate', false);
end;
$$;

revoke all on function public.issue_v09821_prediction(jsonb) from public, anon, authenticated;
grant execute on function public.issue_v09821_prediction(jsonb) to service_role;
revoke all on function public.settle_v09821_prediction(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_v09821_prediction(jsonb, jsonb) to service_role;

-- Preserve settled-row evidence before the only historical backfill in this migration.
-- Unresolved rows are intentionally not guessed here; live reconcile context classifies them.
create table if not exists public.daily_prediction_results_v09823_settled_backup
  (like public.daily_prediction_results including all);
insert into public.daily_prediction_results_v09823_settled_backup
select * from public.daily_prediction_results
where settlement_final is true
on conflict do nothing;

update public.daily_prediction_results
set issuance_status = 'settled',
    issuance_status_updated_at = now(),
    issuance_status_reason = 'v09823_explicit_settled_backfill_after_backup'
where settlement_final is true
  and issuance_status is distinct from 'settled';

create or replace function public.reconcile_v09823_prediction_lifecycle(
  p_source text,
  p_table_id text,
  p_current_shoe text,
  p_current_visible_round integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
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
        issuance_status_updated_at = now(),
        issuance_status_reason = case
          when shoe_no is distinct from p_current_shoe then 'live_screen_shoe_changed_before_authoritative_final'
          when round_no < p_current_visible_round then 'live_screen_round_passed_without_authoritative_final'
          else 'live_screen_identity_current_or_future'
        end
    where source = p_source
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

  return jsonb_build_object(
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

revoke all on function public.reconcile_v09823_prediction_lifecycle(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.reconcile_v09823_prediction_lifecycle(text, text, text, integer) to service_role;

create or replace function public.get_v09823_prediction_lifecycle_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'active_pending', count(*) filter (where issuance_status = 'pending'),
    'settled', count(*) filter (where issuance_status = 'settled'),
    'expired_no_final', count(*) filter (where issuance_status = 'expired_no_final'),
    'abandoned_shoe_change', count(*) filter (where issuance_status = 'abandoned_shoe_change'),
    'unclassified', count(*) filter (where issuance_status is null),
    'total', count(*)
  )
  from public.daily_prediction_results
  where prediction_issued_at is not null;
$$;

revoke all on function public.get_v09823_prediction_lifecycle_stats() from public, anon, authenticated;
grant execute on function public.get_v09823_prediction_lifecycle_stats() to service_role;
