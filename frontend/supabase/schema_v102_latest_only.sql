-- v102 latest-only additive RPC cutover. Apply before deploying the v102-only application.
-- Old entry points are intentionally retained until live cutover verification completes.

begin;

CREATE OR REPLACE FUNCTION public.apply_v102_rank_ledger_event(p_event jsonb, p_ledger jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'extensions'
    AS $$
declare
  v_source text := nullif(p_event->>'source', '');
  v_table text := nullif(p_event->>'table_id', '');
  v_shoe text := nullif(p_event->>'shoe_no', '');
  v_round integer;
  v_action text := nullif(p_event->>'source_action', '');
  v_raw jsonb := p_event->'raw_result_exact10';
  v_hash text;
  v_existing_event public.shoe_round_card_events%rowtype;
  v_existing_ledger public.shoe_rank_ledgers%rowtype;
  v_expected integer;
  v_card integer;
  v_rank text;
  v_cards_seen integer;
  v_revision bigint;
  v_ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  v_zero_seen jsonb;
  v_zero_codes jsonb;
  v_new_seen jsonb;
  v_new_codes jsonb;
  v_undealt jsonb;
  v_delta jsonb := '{}'::jsonb;
  v_checksum text;
begin
  begin
    v_round := nullif(p_event->>'round_no', '')::integer;
  exception when others then
    raise exception 'invalid verified-Final rank event';
  end;

  if v_source is null or v_table is null or v_shoe is null or v_round is null or v_round < 1
     or v_action not in (
       'summary', '/summary', '/api/v1/gametype/*/game/*/room/*/table/*/summary',
       'show_win', '/show_win', '/api/v1/gametype/*/game/*/room/*/table/*/show_win'
     )
     or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) <> 10 then
    raise exception 'invalid verified-Final rank event';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_raw) with ordinality as x(value, position)
    where jsonb_typeof(value) <> 'number'
       or (value::text)::numeric <> trunc((value::text)::numeric)
       or (position between 1 and 4 and (value::text)::integer not between 1 and 52)
       or (position between 5 and 8 and (value::text)::integer not between -1 and 52)
       or (position between 9 and 10 and (value::text)::integer not between 0 and 9)
  ) then
    raise exception 'invalid exact10 card values';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v102-rank|' || v_source || '|' || v_table || '|' || v_shoe, 0)
  );

  select jsonb_object_agg(rank, 0) into v_zero_seen from unnest(v_ranks) as r(rank);
  select jsonb_object_agg(code::text, 0) into v_zero_codes from generate_series(1, 52) as c(code);
  v_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('source_action', v_action, 'raw_result_exact10', v_raw)::text, 'UTF8'
  ), 'sha256'), 'hex');
  select coalesce(jsonb_object_agg(rank, count), '{}'::jsonb)
    into v_delta
  from (
    select v_ranks[(((card.value::text)::integer - 1) % 13) + 1] as rank, count(*)::integer as count
    from jsonb_array_elements(v_raw) with ordinality as card(value, position)
    where card.position between 1 and 6 and (card.value::text)::integer between 1 and 52
    group by 1
  ) as derived_delta;

  select * into v_existing_event
  from public.shoe_round_card_events
  where source = v_source and table_id = v_table and shoe_no = v_shoe and round_no = v_round
  for update;

  if v_existing_event.id is not null and v_existing_event.event_hash is distinct from v_hash then
    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, seen_dealt_rank_counts, seen_dealt_code_counts,
      undealt_after_observed_deals, status, ledger_checksum
    ) values (
      v_source, v_table, v_shoe, v_zero_seen, v_zero_codes, v_zero_seen,
      'conflicted', repeat('0', 64)
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'conflicted', revision = shoe_rank_ledgers.revision + 1, updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'conflicted', 'reason', 'conflicting_round_identity');
  end if;

  select * into v_existing_ledger
  from public.shoe_rank_ledgers
  where source = v_source and table_id = v_table and shoe_no = v_shoe
  for update;

  if v_existing_ledger.status in ('conflicted', 'invalid') then
    return jsonb_build_object('accepted', false, 'status', v_existing_ledger.status, 'revision', v_existing_ledger.revision);
  end if;

  if v_existing_event.applied is true then
    return jsonb_build_object(
      'accepted', true, 'duplicate', true, 'status', v_existing_ledger.status,
      'complete_through_round', v_existing_ledger.complete_through_round,
      'revision', v_existing_ledger.revision,
      'seen_dealt_rank_counts', v_existing_ledger.seen_dealt_rank_counts,
      'seen_dealt_code_counts', v_existing_ledger.seen_dealt_code_counts,
      'undealt_after_observed_deals', v_existing_ledger.undealt_after_observed_deals,
      'cards_seen_dealt', v_existing_ledger.cards_seen_dealt,
      'ledger_checksum', v_existing_ledger.ledger_checksum,
      'physical_remaining_exact', v_existing_ledger.physical_remaining_exact,
      'burn_observation_status', v_existing_ledger.burn_observation_status
    );
  end if;

  v_expected := coalesce(v_existing_ledger.complete_through_round, 0) + 1;
  if v_round <> v_expected then
    insert into public.shoe_round_card_events (
      source, table_id, shoe_no, round_no, raw_result_exact10, dealt_rank_delta, source_action, event_hash, applied
    ) values (v_source, v_table, v_shoe, v_round, v_raw, v_delta, v_action, v_hash, false)
    on conflict (source, table_id, shoe_no, round_no) do nothing;

    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, seen_dealt_rank_counts, seen_dealt_code_counts,
      undealt_after_observed_deals, status, ledger_checksum
    ) values (
      v_source, v_table, v_shoe, v_zero_seen, v_zero_codes, v_zero_seen,
      'gap', repeat('0', 64)
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'gap', revision = shoe_rank_ledgers.revision + 1, updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'gap', 'expected_round', v_expected);
  end if;

  v_new_seen := coalesce(v_existing_ledger.seen_dealt_rank_counts, v_zero_seen);
  v_new_codes := coalesce(v_existing_ledger.seen_dealt_code_counts, v_zero_codes);
  v_cards_seen := coalesce(v_existing_ledger.cards_seen_dealt, 0);

  for v_card in
    select (value::text)::integer
    from jsonb_array_elements(v_raw) with ordinality as card(value, position)
    where position between 1 and 6 and (value::text)::integer between 1 and 52
  loop
    v_rank := v_ranks[((v_card - 1) % 13) + 1];
    v_new_seen := jsonb_set(v_new_seen, array[v_rank], to_jsonb(coalesce((v_new_seen->>v_rank)::integer, 0) + 1), true);
    v_new_codes := jsonb_set(v_new_codes, array[v_card::text], to_jsonb(coalesce((v_new_codes->>v_card::text)::integer, 0) + 1), true);
    v_cards_seen := v_cards_seen + 1;
  end loop;

  if v_cards_seen > 416
     or exists (select 1 from jsonb_each_text(v_new_seen) where value::integer not between 0 and 32)
     or exists (select 1 from jsonb_each_text(v_new_codes) where value::integer not between 0 and 8) then
    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, seen_dealt_rank_counts, seen_dealt_code_counts,
      undealt_after_observed_deals, cards_seen_dealt, status, ledger_checksum
    ) values (
      v_source, v_table, v_shoe, coalesce(v_existing_ledger.seen_dealt_rank_counts, v_zero_seen),
      coalesce(v_existing_ledger.seen_dealt_code_counts, v_zero_codes), v_zero_seen,
      coalesce(v_existing_ledger.cards_seen_dealt, 0), 'invalid', repeat('0', 64)
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'invalid', revision = shoe_rank_ledgers.revision + 1, updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'invalid', 'reason', 'physical_card_limit_exceeded');
  end if;

  select jsonb_object_agg(rank, 32 - coalesce((v_new_seen->>rank)::integer, 0))
    into v_undealt from unnest(v_ranks) as r(rank);
  v_checksum := encode(extensions.digest(convert_to(jsonb_build_object(
    'source', v_source, 'table_id', v_table, 'shoe_no', v_shoe,
    'complete_through_round', v_round, 'seen_dealt_rank_counts', v_new_seen,
    'seen_dealt_code_counts', v_new_codes, 'cards_seen_dealt', v_cards_seen,
    'physical_remaining_exact', false, 'burn_observation_status', 'unavailable'
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.shoe_round_card_events (
    source, table_id, shoe_no, round_no, raw_result_exact10, dealt_rank_delta, source_action, event_hash, applied
  ) values (v_source, v_table, v_shoe, v_round, v_raw, v_delta, v_action, v_hash, true)
  on conflict (source, table_id, shoe_no, round_no) do update set applied = true
  where shoe_round_card_events.event_hash = excluded.event_hash
    and shoe_round_card_events.applied = false;

  insert into public.shoe_rank_ledgers (
    source, table_id, shoe_no, complete_through_round, seen_dealt_rank_counts,
    seen_dealt_code_counts, undealt_after_observed_deals, cards_seen_dealt,
    physical_remaining_exact, burn_observation_status, status, ledger_checksum, revision
  ) values (
    v_source, v_table, v_shoe, v_round, v_new_seen, v_new_codes, v_undealt, v_cards_seen,
    false, 'unavailable', 'contiguous', v_checksum, 1
  ) on conflict (source, table_id, shoe_no) do update set
    complete_through_round = excluded.complete_through_round,
    seen_dealt_rank_counts = excluded.seen_dealt_rank_counts,
    seen_dealt_code_counts = excluded.seen_dealt_code_counts,
    undealt_after_observed_deals = excluded.undealt_after_observed_deals,
    cards_seen_dealt = excluded.cards_seen_dealt,
    status = 'contiguous', ledger_checksum = excluded.ledger_checksum,
    revision = shoe_rank_ledgers.revision + 1, updated_at = now();

  select revision into v_revision from public.shoe_rank_ledgers
  where source = v_source and table_id = v_table and shoe_no = v_shoe;
  return jsonb_build_object(
    'accepted', true, 'duplicate', false, 'status', 'contiguous',
    'complete_through_round', v_round, 'revision', v_revision,
    'seen_dealt_rank_counts', v_new_seen,
    'seen_dealt_code_counts', v_new_codes,
    'undealt_after_observed_deals', v_undealt,
    'cards_seen_dealt', v_cards_seen,
    'ledger_checksum', v_checksum,
    'physical_remaining_exact', false,
    'burn_observation_status', 'unavailable'
  );
end;
$$;

revoke all on function public.apply_v102_rank_ledger_event(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_v102_rank_ledger_event(jsonb, jsonb) to service_role;

create or replace function public.persist_v102_settled_round(
  p_roadmap jsonb,
  p_prediction jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  roadmap_durable boolean := false;
  prediction_durable boolean := false;
  roadmap_written integer := 0;
  prediction_written integer := 0;
begin
  if nullif(p_roadmap->>'source', '') is null
     or nullif(p_roadmap->>'table_id', '') is null
     or nullif(p_roadmap->>'shoe_no', '') is null
     or nullif(p_roadmap->>'round_no', '') is null
     or p_prediction->>'strategy_version' is distinct from 'v102'
     or p_roadmap->>'source' is distinct from p_prediction->>'source'
     or p_roadmap->>'table_id' is distinct from p_prediction->>'table_id'
     or p_roadmap->>'shoe_no' is distinct from p_prediction->>'shoe_no'
     or p_roadmap->>'round_no' is distinct from p_prediction->>'round_no' then
    raise exception 'settlement identity mismatch';
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
  if roadmap_written <> 1 then
    raise exception 'conflicting existing roadmap settlement';
  end if;

  insert into public.daily_prediction_results (
    source, table_id, shoe_no, round_no, strategy_version,
    predicted_result, confidence, actual_result, is_hit,
    table_recent_hit_rate, table_recent_prediction_count, short_run_adjustment,
    prediction_features, probabilities, resolved_at
  ) values (
    p_prediction->>'source', p_prediction->>'table_id', p_prediction->>'shoe_no', (p_prediction->>'round_no')::integer, p_prediction->>'strategy_version',
    p_prediction->>'predicted_result', (p_prediction->>'confidence')::integer, p_prediction->>'actual_result', (p_prediction->>'is_hit')::boolean,
    nullif(p_prediction->>'table_recent_hit_rate', '')::numeric, nullif(p_prediction->>'table_recent_prediction_count', '')::integer,
    coalesce(p_prediction->'short_run_adjustment', '{}'::jsonb), coalesce(p_prediction->'prediction_features', '{}'::jsonb),
    coalesce(p_prediction->'probabilities', '{}'::jsonb), nullif(p_prediction->>'resolved_at', '')::timestamptz
  )
  on conflict (source, table_id, shoe_no, round_no, strategy_version) do update
    set source = excluded.source
    where (to_jsonb(daily_prediction_results) - 'id' - 'created_at' - 'updated_at')
      = (to_jsonb(excluded) - 'id' - 'created_at' - 'updated_at');
  get diagnostics prediction_written = row_count;
  if prediction_written <> 1 then
    raise exception 'conflicting existing prediction settlement';
  end if;

  select exists (
    select 1 from public.daily_roadmap_events
    where source = p_roadmap->>'source'
      and table_id = p_roadmap->>'table_id'
      and shoe_no = p_roadmap->>'shoe_no'
      and round_no = (p_roadmap->>'round_no')::integer
  ) into roadmap_durable;

  select exists (
    select 1 from public.daily_prediction_results
    where source = p_prediction->>'source'
      and table_id = p_prediction->>'table_id'
      and shoe_no = p_prediction->>'shoe_no'
      and round_no = (p_prediction->>'round_no')::integer
      and strategy_version = p_prediction->>'strategy_version'
  ) into prediction_durable;

  if not roadmap_durable or not prediction_durable then
    raise exception 'settlement durability verification failed';
  end if;

  return jsonb_build_object(
    'persisted', roadmap_durable and prediction_durable,
    'roadmapDurable', roadmap_durable,
    'predictionDurable', prediction_durable
  );
end;
$$;

create or replace function public.issue_v102_prediction(p_prediction jsonb)
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
     or p_prediction->>'strategy_version' is distinct from 'v102'
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

create or replace function public.settle_v102_prediction(p_roadmap jsonb, p_settlement jsonb)
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
     or existing.strategy_version is distinct from 'v102'
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

create or replace function public.reconcile_v102_prediction_lifecycle(
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
    where strategy_version = 'v102'
      and source = p_source
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

create or replace function public.get_v102_prediction_lifecycle_stats()
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
  where strategy_version = 'v102'
    and prediction_issued_at is not null;
$$;

revoke all on function public.persist_v102_settled_round(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.persist_v102_settled_round(jsonb, jsonb) to service_role;
revoke all on function public.issue_v102_prediction(jsonb) from public, anon, authenticated;
grant execute on function public.issue_v102_prediction(jsonb) to service_role;
revoke all on function public.settle_v102_prediction(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_v102_prediction(jsonb, jsonb) to service_role;
revoke all on function public.reconcile_v102_prediction_lifecycle(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.reconcile_v102_prediction_lifecycle(text, text, text, integer) to service_role;
revoke all on function public.get_v102_prediction_lifecycle_stats() from public, anon, authenticated;
grant execute on function public.get_v102_prediction_lifecycle_stats() to service_role;

-- v101 RPC privileges remain available during DB-first cutover.
-- Apply finalize_v102_cutover.sql only after the v102 Proxy and Worker pass E2E.


create table if not exists public.v102_formal_release_previous_active (
  version text primary key,
  captured_at timestamptz not null default now()
);
alter table public.v102_formal_release_previous_active enable row level security;
revoke all on table public.v102_formal_release_previous_active from public, anon, authenticated;

insert into public.v102_formal_release_previous_active(version)
select 'v101'
where exists (select 1 from public.ai_strategy_versions where version = 'v101')
  and not exists (select 1 from public.v102_formal_release_previous_active)
on conflict (version) do nothing;

do $$
begin
  if (select count(*) from public.v102_formal_release_previous_active) <> 1
     or not exists (select 1 from public.v102_formal_release_previous_active where version = 'v101') then
    raise exception 'v102 predecessor provenance must contain exactly v101';
  end if;
  if not exists (select 1 from public.ai_strategy_versions where version = 'v101') then
    raise exception 'v101 strategy source is required';
  end if;
end;
$$;

update public.ai_strategy_versions set status = 'archived' where status = 'active' and version <> 'v102';

insert into public.ai_strategy_versions (
  version, status, learned_from_date, sample_count, total_hit_rate,
  high_confidence_hit_rate, weights, metrics, notes, created_at, activated_at
)
select
  'v102', 'active', learned_from_date, 0, total_hit_rate,
  high_confidence_hit_rate,
  jsonb_build_object(
    'roadmap_trend_signals', 0.35,
    'ask_road_signals', 0.15,
    'recent_practical_calibration', 0.30,
    'shoe_banker_player_bias', 0.10,
    'neutral_reserve', 0.10
  ) as weights,
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(metrics, '{side_thresholds}', jsonb_build_object(
            'tie', 30,
            'superSix', 50,
            'bankerPair', 50,
            'playerPair', 50,
            'bankerDragon', 40,
            'playerDragon', 40
          ), true),
          '{description}', to_jsonb('v102正式策略；主預測同源去重、分方向校正與連續同邊信心規則，副預測沿用v101。'::text), true
        ),
        '{main_strategy}', to_jsonb('v102_主預測同源去重與連續同邊信心版'::text), true
      ),
      '{side_strategy}', to_jsonb('v102_副預測沿用v101正式版'::text), true
    ),
    '{main_weights}', jsonb_build_object(
      'roadmap_trend_signals', 0.35,
      'ask_road_signals', 0.15,
      'recent_practical_calibration', 0.30,
      'shoe_banker_player_bias', 0.10,
      'neutral_reserve', 0.10
    ), true
  ),
  'Only active runtime strategy and history source for formal release v102.',
  now(), now()
from public.ai_strategy_versions where version = 'v101'
on conflict (version) do update set
  status = 'active',
  learned_from_date = excluded.learned_from_date,
  sample_count = excluded.sample_count,
  total_hit_rate = excluded.total_hit_rate,
  high_confidence_hit_rate = excluded.high_confidence_hit_rate,
  weights = excluded.weights,
  metrics = excluded.metrics,
  notes = excluded.notes,
  activated_at = now();

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v102') then
    raise exception 'v102 must be the only active strategy';
  end if;
end;
$$;

commit;
