-- v105 production hotfix: an already-finalized prediction was committed atomically with its roadmap row.
-- A durable Queue retry can legitimately omit derived remaining-card counts that the original durable row
-- already contains. Preserve and validate every immutable roadmap field, accept only empty/null derived-count
-- downgrades, reject changed card evidence, and acknowledge the unchanged finalized prediction idempotently.

create or replace function public.settle_v105_prediction(p_roadmap jsonb, p_settlement jsonb)
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
     or existing.strategy_version is distinct from 'v105'
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
    where (to_jsonb(daily_roadmap_events) - 'id' - 'opened_at' - 'created_at' - 'updated_at' - 'remaining_rank_counts' - 'remaining_point_counts')
      = (to_jsonb(excluded) - 'id' - 'opened_at' - 'created_at' - 'updated_at' - 'remaining_rank_counts' - 'remaining_point_counts');
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

revoke all on function public.settle_v105_prediction(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_v105_prediction(jsonb, jsonb) to service_role;
