--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.7

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: license_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.license_status AS ENUM (
    'active',
    'suspended',
    'expired'
);


--
-- Name: manager_license_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.manager_license_status AS ENUM (
    'active',
    'deleted'
);


--
-- Name: manager_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.manager_role AS ENUM (
    'total',
    'secondary'
);


--
-- Name: apply_v100_rank_ledger_event(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_v100_rank_ledger_event(p_event jsonb, p_ledger jsonb DEFAULT NULL::jsonb) RETURNS jsonb
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
    pg_catalog.hashtextextended('v100-rank|' || v_source || '|' || v_table || '|' || v_shoe, 0)
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


--
-- Name: cleanup_cloud_table_snapshots(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_cloud_table_snapshots() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ begin delete from public.cloud_table_snapshots where ctid in (select ctid from public.cloud_table_snapshots where snapshot_at < now() - interval '24 hours' order by snapshot_at limit 500); return null; end; $$;


--
-- Name: cleanup_short_retention_data(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_short_retention_data(retention interval DEFAULT '1 day'::interval) RETURNS TABLE(deleted_roadmap bigint, deleted_predictions bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  roadmap_count bigint;
  prediction_count bigint;
begin
  delete from public.daily_roadmap_events
  where opened_at < now() - retention;
  get diagnostics roadmap_count = row_count;

  delete from public.daily_prediction_results
  where created_at < now() - retention;
  get diagnostics prediction_count = row_count;

  return query select roadmap_count, prediction_count;
end;
$$;


--
-- Name: compact_cloud_table_snapshots(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compact_cloud_table_snapshots() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  rows_before bigint;
  rows_after bigint;
begin
  lock table public.cloud_table_snapshots in access exclusive mode;
  select count(*) into rows_before from public.cloud_table_snapshots;

  create temporary table latest_cloud_snapshots on commit drop as
  select distinct on (session_id)
    id, session_id, capture_source, table_count, tables,
    '[]'::jsonb as table_summary,
    snapshot_at, metadata
  from public.cloud_table_snapshots
  order by session_id, snapshot_at desc;

  truncate table public.cloud_table_snapshots;

  insert into public.cloud_table_snapshots(
    id, session_id, capture_source, table_count, tables, table_summary, snapshot_at, metadata
  )
  select id, session_id, capture_source, table_count, tables, table_summary, snapshot_at, metadata
  from latest_cloud_snapshots;

  get diagnostics rows_after = row_count;
  return jsonb_build_object(
    'compacted', true,
    'rowsBefore', rows_before,
    'rowsAfter', rows_after,
    'rowsRemoved', rows_before - rows_after
  );
end;
$$;


--
-- Name: get_v100_prediction_lifecycle_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_v100_prediction_lifecycle_stats() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select jsonb_build_object(
    'active_pending', count(*) filter (where issuance_status = 'pending'),
    'settled', count(*) filter (where issuance_status = 'settled'),
    'expired_no_final', count(*) filter (where issuance_status = 'expired_no_final'),
    'abandoned_shoe_change', count(*) filter (where issuance_status = 'abandoned_shoe_change'),
    'unclassified', count(*) filter (where issuance_status is null),
    'total', count(*)
  )
  from public.daily_prediction_results
  where strategy_version = 'v100'
    and prediction_issued_at is not null;
$$;


--
-- Name: issue_v100_prediction(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.issue_v100_prediction(p_prediction jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  issued public.daily_prediction_results%rowtype;
begin
  if nullif(p_prediction->>'source', '') is null
     or nullif(p_prediction->>'table_id', '') is null
     or nullif(p_prediction->>'shoe_no', '') is null
     or nullif(p_prediction->>'round_no', '') is null
     or nullif(p_prediction->>'strategy_version', '') is null
     or p_prediction->>'strategy_version' is distinct from 'v100'
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


--
-- Name: limit_cloud_table_snapshot_writes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.limit_cloud_table_snapshot_writes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  previous_snapshot public.cloud_table_snapshots%rowtype;
  has_round_or_shoe_change boolean := false;
  has_connection_transition boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(new.session_id, '')));
  select * into previous_snapshot
  from public.cloud_table_snapshots
  where session_id is not distinct from new.session_id
  order by snapshot_at desc
  limit 1;

  if previous_snapshot.id is not null
     and previous_snapshot.snapshot_at > now() - interval '30 seconds' then
    has_connection_transition :=
      new.metadata->'connectionState' is distinct from previous_snapshot.metadata->'connectionState';

    select exists (
      select 1
      from jsonb_array_elements(coalesce(new.table_summary, '[]'::jsonb)) next_table
      left join jsonb_array_elements(coalesce(previous_snapshot.table_summary, '[]'::jsonb)) prior_table
        on prior_table->>'tableId' = next_table->>'tableId'
      where prior_table is null
         or next_table->>'shoe' is distinct from prior_table->>'shoe'
         or coalesce(nullif(next_table->>'round', '')::integer, 0)
            > coalesce(nullif(prior_table->>'round', '')::integer, 0)
    ) into has_round_or_shoe_change;

    if not has_connection_transition and not has_round_or_shoe_change then
      return null;
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: persist_latest_cloud_table_snapshot(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persist_latest_cloud_table_snapshot(p_snapshot jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  snapshot_session text := nullif(p_snapshot->>'session_id', '');
  snapshot_id uuid;
  inserted_row boolean := false;
begin
  if snapshot_session is null then
    raise exception 'snapshot session_id is required';
  end if;
  if jsonb_typeof(coalesce(p_snapshot->'tables', 'null'::jsonb)) <> 'array' then
    raise exception 'snapshot tables must be an array';
  end if;

  perform pg_advisory_xact_lock(hashtext(snapshot_session));

  update public.cloud_table_snapshots
  set session_id = snapshot_session,
      capture_source = coalesce(nullif(p_snapshot->>'capture_source', ''), 'offline'),
      table_count = coalesce(nullif(p_snapshot->>'table_count', '')::integer, jsonb_array_length(p_snapshot->'tables')),
      tables = p_snapshot->'tables',
      table_summary = '[]'::jsonb,
      snapshot_at = coalesce(nullif(p_snapshot->>'snapshot_at', '')::timestamptz, now()),
      metadata = coalesce(p_snapshot->'metadata', '{}'::jsonb)
  where id = (
    select id
    from public.cloud_table_snapshots
    where session_id is not distinct from snapshot_session
    order by snapshot_at desc
    limit 1
  )
  returning id into snapshot_id;

  if not found then
    insert into public.cloud_table_snapshots(
      session_id, capture_source, table_count, tables, table_summary, snapshot_at, metadata
    ) values (
      snapshot_session,
      coalesce(nullif(p_snapshot->>'capture_source', ''), 'offline'),
      coalesce(nullif(p_snapshot->>'table_count', '')::integer, jsonb_array_length(p_snapshot->'tables')),
      p_snapshot->'tables',
      '[]'::jsonb,
      coalesce(nullif(p_snapshot->>'snapshot_at', '')::timestamptz, now()),
      coalesce(p_snapshot->'metadata', '{}'::jsonb)
    )
    returning id into snapshot_id;
    inserted_row := true;
  end if;

  return jsonb_build_object('persisted', true, 'inserted', inserted_row, 'id', snapshot_id);
end;
$$;


--
-- Name: persist_v100_settled_round(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persist_v100_settled_round(p_roadmap jsonb, p_prediction jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
     or p_prediction->>'strategy_version' is distinct from 'v100'
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


--
-- Name: purge_expired_manager_licenses(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_expired_manager_licenses() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  delete from public.manager_licenses
  where expires_on <= current_date - 3;
$$;


--
-- Name: reconcile_v100_prediction_lifecycle(text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_v100_prediction_lifecycle(p_source text, p_table_id text, p_current_shoe text, p_current_visible_round integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    where strategy_version = 'v100'
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


--
-- Name: reject_v100_rank_event_evidence_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_v100_rank_event_evidence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'v100 rank event evidence is immutable';
  end if;
  if new.source is distinct from old.source
     or new.table_id is distinct from old.table_id
     or new.shoe_no is distinct from old.shoe_no
     or new.round_no is distinct from old.round_no
     or new.raw_result_exact10 is distinct from old.raw_result_exact10
     or new.dealt_rank_delta is distinct from old.dealt_rank_delta
     or new.source_action is distinct from old.source_action
     or new.event_hash is distinct from old.event_hash
     or new.received_at is distinct from old.received_at
     or new.created_at is distinct from old.created_at then
    raise exception 'v100 rank event evidence is immutable';
  end if;
  return new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: settle_v100_prediction(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_v100_prediction(p_roadmap jsonb, p_settlement jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
     or existing.strategy_version is distinct from 'v100'
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


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_logs (
    id bigint NOT NULL,
    project_id uuid,
    actor text,
    action text NOT NULL,
    target_table text,
    target_id text,
    before_data jsonb,
    after_data jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_logs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.admin_audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: admin_operation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_operation_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_account text,
    action text NOT NULL,
    target_type text,
    target_code text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_profiles (
    id uuid NOT NULL,
    display_name text,
    role text DEFAULT 'admin'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_profiles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text])))
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'agent'::text NOT NULL,
    parent_code text,
    permission text DEFAULT '可建碼'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_strategy_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_strategy_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    learned_from_date date,
    sample_count integer DEFAULT 0 NOT NULL,
    total_hit_rate numeric(6,4),
    high_confidence_hit_rate numeric(6,4),
    weights jsonb DEFAULT '{}'::jsonb NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT ai_strategy_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text, 'rollback'::text])))
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baccarat_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baccarat_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text DEFAULT 'ofalive99'::text NOT NULL,
    table_id text NOT NULL,
    table_name text,
    display_name text,
    table_type text,
    current_shoe text,
    current_round integer,
    total_round_banker integer DEFAULT 0 NOT NULL,
    total_round_player integer DEFAULT 0 NOT NULL,
    total_round_tie integer DEFAULT 0 NOT NULL,
    total_round_banker_pair integer DEFAULT 0 NOT NULL,
    total_round_player_pair integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    raw_trend jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_capture_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_capture_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_key text,
    capture_source text DEFAULT 'cloud_browser'::text NOT NULL,
    deploy_mode text DEFAULT 'cloud'::text NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: cloud_capture_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_capture_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id text,
    capture_source text DEFAULT 'offline'::text NOT NULL,
    deploy_mode text,
    connected boolean DEFAULT false NOT NULL,
    authenticated boolean DEFAULT false NOT NULL,
    table_count integer DEFAULT 0 NOT NULL,
    last_message_at timestamp with time zone,
    last_round_at timestamp with time zone,
    status_text text,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_operational_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_operational_events (
    id bigint NOT NULL,
    event_layer text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    component text,
    event_kind text,
    status_code integer,
    message text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_operational_events_event_layer_check CHECK ((event_layer = ANY (ARRAY['capture_error'::text, 'write_error'::text, 'monitor_error'::text, 'control_error'::text]))),
    CONSTRAINT cloud_operational_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: TABLE cloud_operational_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cloud_operational_events IS 'Capture/write/monitor/control 分層事件紀錄；不得存放 token/service key/raw secret。';


--
-- Name: COLUMN cloud_operational_events.event_layer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_operational_events.event_layer IS '事件分層：capture_error、write_error、monitor_error、control_error。';


--
-- Name: cloud_operational_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cloud_operational_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cloud_operational_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cloud_operational_events_id_seq OWNED BY public.cloud_operational_events.id;


--
-- Name: cloud_strategy_adjustment_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_strategy_adjustment_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id text,
    strategy_mode text NOT NULL,
    evaluated integer DEFAULT 0 NOT NULL,
    hits integer DEFAULT 0 NOT NULL,
    misses integer DEFAULT 0 NOT NULL,
    hit_rate numeric,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_strategy_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_strategy_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    strategy_version text,
    report_type text DEFAULT 'cloud_live_test'::text NOT NULL,
    rounds integer DEFAULT 0 NOT NULL,
    hits integer DEFAULT 0 NOT NULL,
    misses integer DEFAULT 0 NOT NULL,
    pushes integer DEFAULT 0 NOT NULL,
    main_evaluated integer DEFAULT 0 NOT NULL,
    main_hit_rate numeric,
    report_path text,
    raw_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_table_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_table_rounds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id text,
    source text DEFAULT 'ofalive99'::text NOT NULL,
    table_id text NOT NULL,
    table_name text,
    shoe_no text,
    round_no integer DEFAULT 0 NOT NULL,
    main_result text,
    banker_points integer,
    player_points integer,
    raw_event jsonb DEFAULT '{}'::jsonb NOT NULL,
    table_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: cloud_table_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_table_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id text,
    capture_source text DEFAULT 'offline'::text NOT NULL,
    table_count integer DEFAULT 0 NOT NULL,
    tables jsonb DEFAULT '[]'::jsonb NOT NULL,
    table_summary jsonb DEFAULT '[]'::jsonb NOT NULL,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: daily_prediction_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_prediction_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text DEFAULT 'ofalive99'::text NOT NULL,
    table_id text NOT NULL,
    shoe_no text,
    round_no integer NOT NULL,
    strategy_version text,
    predicted_result text NOT NULL,
    confidence integer NOT NULL,
    actual_result text,
    is_hit boolean,
    prediction_features jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    probabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    feature_weights jsonb DEFAULT '{}'::jsonb NOT NULL,
    table_recent_hit_rate numeric,
    table_recent_prediction_count integer,
    short_run_adjustment jsonb DEFAULT '{}'::jsonb NOT NULL,
    prediction_issued_at timestamp with time zone,
    issued_prediction_payload jsonb,
    settlement_final boolean,
    settlement_source_action text,
    side_actual_results jsonb,
    side_hits jsonb,
    settlement_status text,
    issuance_status text,
    issuance_status_updated_at timestamp with time zone,
    issuance_status_reason text,
    CONSTRAINT daily_prediction_results_actual_result_check CHECK ((actual_result = ANY (ARRAY['banker'::text, 'player'::text, 'tie'::text]))),
    CONSTRAINT daily_prediction_results_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT daily_prediction_results_issuance_status_check CHECK (((issuance_status IS NULL) OR (issuance_status = ANY (ARRAY['pending'::text, 'settled'::text, 'expired_no_final'::text, 'abandoned_shoe_change'::text])))),
    CONSTRAINT daily_prediction_results_predicted_result_check CHECK ((predicted_result = ANY (ARRAY['banker'::text, 'player'::text, 'tie'::text, 'observe'::text]))),
    CONSTRAINT daily_prediction_results_settlement_status_check CHECK (((settlement_status IS NULL) OR (settlement_status = ANY (ARRAY['hit'::text, 'miss'::text, 'push'::text, 'unknown'::text]))))
);


--
-- Name: daily_roadmap_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_roadmap_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text DEFAULT 'ofalive99'::text NOT NULL,
    table_id text NOT NULL,
    shoe_no text,
    round_no integer NOT NULL,
    main_result text NOT NULL,
    banker_points integer,
    player_points integer,
    point_diff integer GENERATED ALWAYS AS (abs((COALESCE(banker_points, 0) - COALESCE(player_points, 0)))) STORED,
    is_tie boolean GENERATED ALWAYS AS ((main_result = 'tie'::text)) STORED,
    banker_pair boolean DEFAULT false NOT NULL,
    player_pair boolean DEFAULT false NOT NULL,
    super_six boolean DEFAULT false NOT NULL,
    bead_code text,
    raw_event jsonb,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    banker_dragon boolean DEFAULT false NOT NULL,
    player_dragon boolean DEFAULT false NOT NULL,
    player_card_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    banker_card_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    player_card_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    banker_card_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    player_card_ranks jsonb DEFAULT '[]'::jsonb NOT NULL,
    banker_card_ranks jsonb DEFAULT '[]'::jsonb NOT NULL,
    player_card_faces jsonb DEFAULT '[]'::jsonb NOT NULL,
    banker_card_faces jsonb DEFAULT '[]'::jsonb NOT NULL,
    player_drew boolean,
    banker_drew boolean,
    player_natural boolean,
    banker_natural boolean,
    road_features jsonb DEFAULT '{}'::jsonb NOT NULL,
    remaining_rank_counts jsonb,
    remaining_point_counts jsonb,
    CONSTRAINT daily_roadmap_events_banker_points_check CHECK (((banker_points >= 0) AND (banker_points <= 9))),
    CONSTRAINT daily_roadmap_events_main_result_check CHECK ((main_result = ANY (ARRAY['banker'::text, 'player'::text, 'tie'::text]))),
    CONSTRAINT daily_roadmap_events_player_points_check CHECK (((player_points >= 0) AND (player_points <= 9)))
);


--
-- Name: COLUMN daily_roadmap_events.road_features; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daily_roadmap_events.road_features IS 'Live writer不重複寫入路單原文；路單原文保留在cloud_table_snapshots/tables來源。';


--
-- Name: COLUMN daily_roadmap_events.remaining_rank_counts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daily_roadmap_events.remaining_rank_counts IS '保留A-K剩餘牌面張數，供副預測與回測重算；不存重複路單原文。';


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    flag_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    rollout jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: license_validation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.license_validation_logs (
    id bigint NOT NULL,
    license_id uuid,
    submitted_code text NOT NULL,
    result text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    member_account text,
    CONSTRAINT license_validation_logs_result_check CHECK ((result = ANY (ARRAY['valid'::text, 'missing'::text, 'suspended'::text, 'expired'::text])))
);


--
-- Name: license_validation_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.license_validation_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.license_validation_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.licenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    agent_id uuid NOT NULL,
    plan_id uuid,
    starts_on date DEFAULT CURRENT_DATE NOT NULL,
    expires_on date NOT NULL,
    status public.license_status DEFAULT 'active'::public.license_status NOT NULL,
    validation_count integer DEFAULT 0 NOT NULL,
    last_validated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    member_account text,
    CONSTRAINT licenses_check CHECK ((expires_on >= starts_on)),
    CONSTRAINT licenses_code_check CHECK ((code ~ '^[A-Za-z]+[0-9]{4}_[0-9]{3,}$'::text))
);


--
-- Name: live_table_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_table_snapshots (
    table_key text NOT NULL,
    table_label text NOT NULL,
    road jsonb DEFAULT '[]'::jsonb NOT NULL,
    hand_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_license_id uuid
);


--
-- Name: manager_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manager_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    username_key text GENERATED ALWAYS AS (lower(username)) STORED,
    password_salt text NOT NULL,
    password_hash text NOT NULL,
    role public.manager_role DEFAULT 'secondary'::public.manager_role NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT manager_username_format CHECK ((username ~ '^[A-Za-z0-9_]{3,32}$'::text))
);


--
-- Name: manager_licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manager_licenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    manager_id uuid NOT NULL,
    plan_code text NOT NULL,
    issued_on date DEFAULT CURRENT_DATE NOT NULL,
    expires_on date NOT NULL,
    status public.manager_license_status DEFAULT 'active'::public.manager_license_status NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT manager_license_expiry CHECK ((expires_on >= issued_on)),
    CONSTRAINT manager_licenses_plan_code_check CHECK ((plan_code = ANY (ARRAY['1Day'::text, '3Day'::text, '7Day'::text, '15Day'::text, '30Day'::text])))
);


--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account text NOT NULL,
    agent_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    category text DEFAULT 'note'::text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    importance integer DEFAULT 3 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_items_importance_check CHECK (((importance >= 1) AND (importance <= 5)))
);


--
-- Name: memory_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'paused'::text])))
);


--
-- Name: memory_strategy_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_strategy_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    version text NOT NULL,
    name text,
    status text DEFAULT 'draft'::text NOT NULL,
    main_weights jsonb DEFAULT '{}'::jsonb NOT NULL,
    side_thresholds jsonb DEFAULT '{}'::jsonb NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT memory_strategy_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text, 'testing'::text])))
);


--
-- Name: memory_test_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_test_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    strategy_version text,
    report_type text DEFAULT 'live_test'::text NOT NULL,
    report_date date,
    rounds integer DEFAULT 0 NOT NULL,
    hits integer DEFAULT 0 NOT NULL,
    misses integer DEFAULT 0 NOT NULL,
    pushes integer DEFAULT 0 NOT NULL,
    main_evaluated integer DEFAULT 0 NOT NULL,
    main_hit_rate numeric(6,2),
    side_actions integer DEFAULT 0 NOT NULL,
    side_hits integer DEFAULT 0 NOT NULL,
    side_hit_rate numeric(6,2),
    report_path text,
    raw_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: model_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version text NOT NULL,
    provider text,
    model_name text,
    training_period daterange,
    dataset_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    artifact_url text,
    status text DEFAULT 'planned'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT model_versions_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'training'::text, 'active'::text, 'archived'::text, 'failed'::text])))
);


--
-- Name: online_app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.online_app_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    scope text DEFAULT 'global'::text NOT NULL,
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    is_public boolean DEFAULT false NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    duration_days integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plans_duration_days_check CHECK ((duration_days > 0))
);


--
-- Name: schema_migration_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migration_versions (
    version text NOT NULL,
    description text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: shoe_rank_ledgers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shoe_rank_ledgers (
    source text NOT NULL,
    table_id text NOT NULL,
    shoe_no text NOT NULL,
    deck_count integer DEFAULT 8 NOT NULL,
    complete_through_round integer DEFAULT 0 NOT NULL,
    seen_dealt_rank_counts jsonb NOT NULL,
    seen_dealt_code_counts jsonb NOT NULL,
    undealt_after_observed_deals jsonb NOT NULL,
    cards_seen_dealt integer DEFAULT 0 NOT NULL,
    physical_remaining_exact boolean DEFAULT false NOT NULL,
    burn_observation_status text DEFAULT 'unavailable'::text NOT NULL,
    status text DEFAULT 'waiting_round1'::text NOT NULL,
    ledger_checksum text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shoe_rank_ledgers_burn_observation_status_check CHECK ((burn_observation_status = 'unavailable'::text)),
    CONSTRAINT shoe_rank_ledgers_cards_seen_dealt_check CHECK (((cards_seen_dealt >= 0) AND (cards_seen_dealt <= 416))),
    CONSTRAINT shoe_rank_ledgers_code_object CHECK ((jsonb_typeof(seen_dealt_code_counts) = 'object'::text)),
    CONSTRAINT shoe_rank_ledgers_complete_through_round_check CHECK ((complete_through_round >= 0)),
    CONSTRAINT shoe_rank_ledgers_deck_count_check CHECK ((deck_count = 8)),
    CONSTRAINT shoe_rank_ledgers_ledger_checksum_check CHECK ((ledger_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT shoe_rank_ledgers_physical_remaining_exact_check CHECK ((physical_remaining_exact = false)),
    CONSTRAINT shoe_rank_ledgers_revision_check CHECK ((revision >= 0)),
    CONSTRAINT shoe_rank_ledgers_seen_object CHECK ((jsonb_typeof(seen_dealt_rank_counts) = 'object'::text)),
    CONSTRAINT shoe_rank_ledgers_status_check CHECK ((status = ANY (ARRAY['waiting_round1'::text, 'contiguous'::text, 'gap'::text, 'conflicted'::text, 'invalid'::text]))),
    CONSTRAINT shoe_rank_ledgers_undealt_object CHECK ((jsonb_typeof(undealt_after_observed_deals) = 'object'::text))
);


--
-- Name: shoe_round_card_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shoe_round_card_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    table_id text NOT NULL,
    shoe_no text NOT NULL,
    round_no integer NOT NULL,
    raw_result_exact10 jsonb NOT NULL,
    dealt_rank_delta jsonb NOT NULL,
    source_action text NOT NULL,
    event_hash text NOT NULL,
    applied boolean DEFAULT false NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shoe_round_card_events_delta_object CHECK ((jsonb_typeof(dealt_rank_delta) = 'object'::text)),
    CONSTRAINT shoe_round_card_events_event_hash_check CHECK ((event_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT shoe_round_card_events_exact10 CHECK (((jsonb_typeof(raw_result_exact10) = 'array'::text) AND (jsonb_array_length(raw_result_exact10) = 10))),
    CONSTRAINT shoe_round_card_events_round_no_check CHECK ((round_no >= 1))
);


--
-- Name: v100_formal_release_previous_active; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.v100_formal_release_previous_active (
    version text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_operational_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_operational_events ALTER COLUMN id SET DEFAULT nextval('public.cloud_operational_events_id_seq'::regclass);


--
-- Name: admin_audit_logs admin_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_operation_logs admin_operation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_operation_logs
    ADD CONSTRAINT admin_operation_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_profiles admin_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_profiles
    ADD CONSTRAINT admin_profiles_pkey PRIMARY KEY (id);


--
-- Name: agents agents_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_code_key UNIQUE (code);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: ai_strategy_versions ai_strategy_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_strategy_versions
    ADD CONSTRAINT ai_strategy_versions_pkey PRIMARY KEY (id);


--
-- Name: ai_strategy_versions ai_strategy_versions_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_strategy_versions
    ADD CONSTRAINT ai_strategy_versions_version_key UNIQUE (version);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: baccarat_tables baccarat_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baccarat_tables
    ADD CONSTRAINT baccarat_tables_pkey PRIMARY KEY (id);


--
-- Name: baccarat_tables baccarat_tables_source_table_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baccarat_tables
    ADD CONSTRAINT baccarat_tables_source_table_id_key UNIQUE (source, table_id);


--
-- Name: cloud_capture_sessions cloud_capture_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_capture_sessions
    ADD CONSTRAINT cloud_capture_sessions_pkey PRIMARY KEY (id);


--
-- Name: cloud_capture_sessions cloud_capture_sessions_session_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_capture_sessions
    ADD CONSTRAINT cloud_capture_sessions_session_key_key UNIQUE (session_key);


--
-- Name: cloud_capture_status cloud_capture_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_capture_status
    ADD CONSTRAINT cloud_capture_status_pkey PRIMARY KEY (id);


--
-- Name: cloud_capture_status cloud_capture_status_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_capture_status
    ADD CONSTRAINT cloud_capture_status_session_id_key UNIQUE (session_id);


--
-- Name: cloud_operational_events cloud_operational_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_operational_events
    ADD CONSTRAINT cloud_operational_events_pkey PRIMARY KEY (id);


--
-- Name: cloud_strategy_adjustment_stats cloud_strategy_adjustment_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_strategy_adjustment_stats
    ADD CONSTRAINT cloud_strategy_adjustment_stats_pkey PRIMARY KEY (id);


--
-- Name: cloud_strategy_reports cloud_strategy_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_strategy_reports
    ADD CONSTRAINT cloud_strategy_reports_pkey PRIMARY KEY (id);


--
-- Name: cloud_table_rounds cloud_table_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_table_rounds
    ADD CONSTRAINT cloud_table_rounds_pkey PRIMARY KEY (id);


--
-- Name: cloud_table_rounds cloud_table_rounds_source_table_id_shoe_no_round_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_table_rounds
    ADD CONSTRAINT cloud_table_rounds_source_table_id_shoe_no_round_no_key UNIQUE (source, table_id, shoe_no, round_no);


--
-- Name: cloud_table_snapshots cloud_table_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_table_snapshots
    ADD CONSTRAINT cloud_table_snapshots_pkey PRIMARY KEY (id);


--
-- Name: daily_prediction_results daily_prediction_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_prediction_results
    ADD CONSTRAINT daily_prediction_results_pkey PRIMARY KEY (id);


--
-- Name: daily_prediction_results daily_prediction_results_source_table_id_shoe_no_round_no_s_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_prediction_results
    ADD CONSTRAINT daily_prediction_results_source_table_id_shoe_no_round_no_s_key UNIQUE (source, table_id, shoe_no, round_no, strategy_version);


--
-- Name: daily_roadmap_events daily_roadmap_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_roadmap_events
    ADD CONSTRAINT daily_roadmap_events_pkey PRIMARY KEY (id);


--
-- Name: daily_roadmap_events daily_roadmap_events_source_table_id_shoe_no_round_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_roadmap_events
    ADD CONSTRAINT daily_roadmap_events_source_table_id_shoe_no_round_no_key UNIQUE (source, table_id, shoe_no, round_no);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_project_id_flag_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_project_id_flag_key_key UNIQUE (project_id, flag_key);


--
-- Name: license_validation_logs license_validation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_validation_logs
    ADD CONSTRAINT license_validation_logs_pkey PRIMARY KEY (id);


--
-- Name: licenses licenses_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_code_key UNIQUE (code);


--
-- Name: licenses licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_pkey PRIMARY KEY (id);


--
-- Name: live_table_snapshots live_table_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_table_snapshots
    ADD CONSTRAINT live_table_snapshots_pkey PRIMARY KEY (table_key);


--
-- Name: manager_accounts manager_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manager_accounts
    ADD CONSTRAINT manager_accounts_pkey PRIMARY KEY (id);


--
-- Name: manager_accounts manager_accounts_username_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manager_accounts
    ADD CONSTRAINT manager_accounts_username_key_key UNIQUE (username_key);


--
-- Name: manager_licenses manager_licenses_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manager_licenses
    ADD CONSTRAINT manager_licenses_code_key UNIQUE (code);


--
-- Name: manager_licenses manager_licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manager_licenses
    ADD CONSTRAINT manager_licenses_pkey PRIMARY KEY (id);


--
-- Name: members members_account_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_account_key UNIQUE (account);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: memory_items memory_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_items
    ADD CONSTRAINT memory_items_pkey PRIMARY KEY (id);


--
-- Name: memory_projects memory_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_projects
    ADD CONSTRAINT memory_projects_pkey PRIMARY KEY (id);


--
-- Name: memory_projects memory_projects_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_projects
    ADD CONSTRAINT memory_projects_slug_key UNIQUE (slug);


--
-- Name: memory_strategy_versions memory_strategy_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_strategy_versions
    ADD CONSTRAINT memory_strategy_versions_pkey PRIMARY KEY (id);


--
-- Name: memory_strategy_versions memory_strategy_versions_project_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_strategy_versions
    ADD CONSTRAINT memory_strategy_versions_project_id_version_key UNIQUE (project_id, version);


--
-- Name: memory_test_reports memory_test_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_test_reports
    ADD CONSTRAINT memory_test_reports_pkey PRIMARY KEY (id);


--
-- Name: model_versions model_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_versions
    ADD CONSTRAINT model_versions_pkey PRIMARY KEY (id);


--
-- Name: model_versions model_versions_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_versions
    ADD CONSTRAINT model_versions_version_key UNIQUE (version);


--
-- Name: online_app_settings online_app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.online_app_settings
    ADD CONSTRAINT online_app_settings_pkey PRIMARY KEY (id);


--
-- Name: online_app_settings online_app_settings_project_id_scope_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.online_app_settings
    ADD CONSTRAINT online_app_settings_project_id_scope_key_key UNIQUE (project_id, scope, key);


--
-- Name: plans plans_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_name_key UNIQUE (name);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: schema_migration_versions schema_migration_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migration_versions
    ADD CONSTRAINT schema_migration_versions_pkey PRIMARY KEY (version);


--
-- Name: shoe_rank_ledgers shoe_rank_ledgers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoe_rank_ledgers
    ADD CONSTRAINT shoe_rank_ledgers_pkey PRIMARY KEY (source, table_id, shoe_no);


--
-- Name: shoe_round_card_events shoe_round_card_events_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoe_round_card_events
    ADD CONSTRAINT shoe_round_card_events_identity UNIQUE (source, table_id, shoe_no, round_no);


--
-- Name: shoe_round_card_events shoe_round_card_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoe_round_card_events
    ADD CONSTRAINT shoe_round_card_events_pkey PRIMARY KEY (id);


--
-- Name: v100_formal_release_previous_active v100_formal_release_previous_active_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v100_formal_release_previous_active
    ADD CONSTRAINT v100_formal_release_previous_active_pkey PRIMARY KEY (version);


--
-- Name: ai_strategy_versions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_strategy_versions_status_idx ON public.ai_strategy_versions USING btree (status, created_at DESC);


--
-- Name: baccarat_tables_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baccarat_tables_active_idx ON public.baccarat_tables USING btree (is_active, updated_at DESC);


--
-- Name: baccarat_tables_source_table_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baccarat_tables_source_table_idx ON public.baccarat_tables USING btree (source, table_id);


--
-- Name: cloud_capture_status_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_capture_status_updated_idx ON public.cloud_capture_status USING btree (updated_at DESC);


--
-- Name: cloud_operational_events_component_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_operational_events_component_time_idx ON public.cloud_operational_events USING btree (component, occurred_at DESC);


--
-- Name: cloud_operational_events_layer_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_operational_events_layer_time_idx ON public.cloud_operational_events USING btree (event_layer, occurred_at DESC);


--
-- Name: cloud_table_rounds_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cloud_table_rounds_identity_unique ON public.cloud_table_rounds USING btree (source, table_id, shoe_no, round_no);


--
-- Name: INDEX cloud_table_rounds_identity_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.cloud_table_rounds_identity_unique IS '防止Worker round event重送造成cloud_table_rounds重複入庫。';


--
-- Name: cloud_table_snapshots_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_table_snapshots_snapshot_idx ON public.cloud_table_snapshots USING btree (snapshot_at DESC) WHERE (table_count > 0);


--
-- Name: daily_prediction_results_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_prediction_results_created_idx ON public.daily_prediction_results USING btree (created_at DESC);


--
-- Name: daily_prediction_results_v105_recent_table_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_prediction_results_v105_recent_table_idx ON public.daily_prediction_results USING btree (strategy_version, table_id, created_at DESC) WHERE ((settlement_final IS TRUE) AND (prediction_issued_at IS NOT NULL));


create or replace function public.get_v105_recent_performance_rows(p_per_table_limit integer default 60)
returns table (
  id uuid, table_id text, shoe_no text, round_no integer, strategy_version text,
  predicted_result text, actual_result text, is_hit boolean, settlement_final boolean,
  prediction_issued_at timestamptz, created_at timestamptz, prediction_timing text
)
language sql
stable
security definer
set search_path = public
as $$
  select id, table_id, shoe_no, round_no, strategy_version, predicted_result, actual_result,
         is_hit, settlement_final, prediction_issued_at, created_at, prediction_timing
  from (
    (select 1 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG01'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 2 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG02'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 3 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG03'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 4 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG03A'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 5 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG05'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 6 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG06'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 7 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG07'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 8 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG08'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 9 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG09'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
    union all
    (select 10 as table_order, d.id, d.table_id, d.shoe_no, d.round_no, 'v105'::text as strategy_version, d.predicted_result, d.actual_result, d.is_hit, true as settlement_final, d.prediction_issued_at, d.created_at, 'pre_result_context'::text as prediction_timing
     from public.daily_prediction_results d
     where d.strategy_version = 'v105' and d.table_id = 'BAG10'
       and d.settlement_final is true and d.prediction_issued_at is not null
     order by d.created_at desc
     limit least(60, greatest(1, coalesce(p_per_table_limit, 60))))
  ) recent
  order by table_order, created_at desc;
$$;

revoke all on function public.get_v105_recent_performance_rows(integer) from public;
revoke all on function public.get_v105_recent_performance_rows(integer) from anon;
revoke all on function public.get_v105_recent_performance_rows(integer) from authenticated;
grant execute on function public.get_v105_recent_performance_rows(integer) to service_role;



--
-- Name: daily_prediction_results_hit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_prediction_results_hit_idx ON public.daily_prediction_results USING btree (is_hit, created_at DESC);


--
-- Name: daily_prediction_results_identity_strategy_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX daily_prediction_results_identity_strategy_unique ON public.daily_prediction_results USING btree (source, table_id, shoe_no, round_no, strategy_version);


--
-- Name: INDEX daily_prediction_results_identity_strategy_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.daily_prediction_results_identity_strategy_unique IS '防止相同預測身份重送造成重複統計。';


--
-- Name: daily_prediction_results_strategy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_prediction_results_strategy_idx ON public.daily_prediction_results USING btree (strategy_version, created_at DESC);


--
-- Name: daily_prediction_results_table_round_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_prediction_results_table_round_idx ON public.daily_prediction_results USING btree (source, table_id, shoe_no, round_no);


--
-- Name: daily_roadmap_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_roadmap_events_created_idx ON public.daily_roadmap_events USING btree (created_at DESC);


--
-- Name: daily_roadmap_events_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX daily_roadmap_events_identity_unique ON public.daily_roadmap_events USING btree (source, table_id, shoe_no, round_no);


--
-- Name: INDEX daily_roadmap_events_identity_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.daily_roadmap_events_identity_unique IS '防止相同完成局身份重送造成daily_roadmap_events重複入庫。';


--
-- Name: daily_roadmap_events_opened_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_roadmap_events_opened_idx ON public.daily_roadmap_events USING btree (opened_at DESC);


--
-- Name: daily_roadmap_events_remaining_rank_counts_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_roadmap_events_remaining_rank_counts_gin_idx ON public.daily_roadmap_events USING gin (remaining_rank_counts);


--
-- Name: daily_roadmap_events_result_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_roadmap_events_result_idx ON public.daily_roadmap_events USING btree (main_result, opened_at DESC);


--
-- Name: daily_roadmap_events_table_round_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_roadmap_events_table_round_idx ON public.daily_roadmap_events USING btree (source, table_id, shoe_no, round_no);


--
-- Name: idx_admin_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_action ON public.admin_audit_logs USING btree (action);


--
-- Name: idx_admin_audit_project_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_project_created ON public.admin_audit_logs USING btree (project_id, created_at DESC);


--
-- Name: idx_admin_operation_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_operation_logs_created_at ON public.admin_operation_logs USING btree (created_at DESC);


--
-- Name: idx_agents_active_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_active_created ON public.agents USING btree (is_active, created_at DESC);


--
-- Name: idx_agents_parent_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_parent_code ON public.agents USING btree (parent_code);


--
-- Name: idx_cloud_capture_status_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_capture_status_updated_at ON public.cloud_capture_status USING btree (updated_at DESC);


--
-- Name: idx_cloud_strategy_reports_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_strategy_reports_created_at ON public.cloud_strategy_reports USING btree (created_at DESC);


--
-- Name: idx_cloud_table_rounds_table_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_table_rounds_table_time ON public.cloud_table_rounds USING btree (table_id, received_at DESC);


--
-- Name: idx_cloud_table_snapshots_session_snapshot_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_table_snapshots_session_snapshot_at ON public.cloud_table_snapshots USING btree (session_id, snapshot_at DESC);


--
-- Name: idx_cloud_table_snapshots_snapshot_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_table_snapshots_snapshot_at ON public.cloud_table_snapshots USING btree (snapshot_at DESC);


--
-- Name: idx_daily_prediction_results_final_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_prediction_results_final_created_at ON public.daily_prediction_results USING btree (created_at DESC) WHERE ((prediction_features ->> 'settlement_final'::text) = 'true'::text);


--
-- Name: idx_daily_prediction_results_prediction_issued_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_prediction_results_prediction_issued_at ON public.daily_prediction_results USING btree (prediction_issued_at DESC) WHERE (prediction_issued_at IS NOT NULL);


--
-- Name: idx_licenses_agent_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_agent_status ON public.licenses USING btree (agent_id, status);


--
-- Name: idx_licenses_member_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_member_account ON public.licenses USING btree (member_account);


--
-- Name: idx_members_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_agent_id ON public.members USING btree (agent_id);


--
-- Name: idx_memory_items_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_items_metadata ON public.memory_items USING gin (metadata);


--
-- Name: idx_memory_items_project_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_items_project_category ON public.memory_items USING btree (project_id, category);


--
-- Name: idx_memory_items_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_items_tags ON public.memory_items USING gin (tags);


--
-- Name: idx_memory_reports_project_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_reports_project_created ON public.memory_test_reports USING btree (project_id, created_at DESC);


--
-- Name: idx_memory_reports_strategy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_reports_strategy ON public.memory_test_reports USING btree (project_id, strategy_version);


--
-- Name: memory_test_reports_project_strategy_type_date_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memory_test_reports_project_strategy_type_date_key ON public.memory_test_reports USING btree (project_id, strategy_version, report_type, report_date);


--
-- Name: idx_memory_strategy_project_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_strategy_project_status ON public.memory_strategy_versions USING btree (project_id, status);


--
-- Name: idx_online_app_settings_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_online_app_settings_scope ON public.online_app_settings USING btree (project_id, scope);


--
-- Name: idx_shoe_rank_ledgers_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shoe_rank_ledgers_updated ON public.shoe_rank_ledgers USING btree (updated_at DESC);


--
-- Name: idx_shoe_round_card_events_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shoe_round_card_events_received ON public.shoe_round_card_events USING btree (received_at DESC);


--
-- Name: license_validation_logs_license_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX license_validation_logs_license_id_idx ON public.license_validation_logs USING btree (license_id, created_at DESC);


--
-- Name: licenses_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX licenses_code_idx ON public.licenses USING btree (code);


--
-- Name: manager_licenses_code_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manager_licenses_code_active_idx ON public.manager_licenses USING btree (code) WHERE (status = 'active'::public.manager_license_status);


--
-- Name: manager_licenses_manager_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manager_licenses_manager_created_idx ON public.manager_licenses USING btree (manager_id, created_at DESC);


--
-- Name: uq_ai_strategy_versions_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ai_strategy_versions_one_active ON public.ai_strategy_versions USING btree (status) WHERE (status = 'active'::text);


--
-- Name: licenses licenses_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER licenses_touch_updated_at BEFORE UPDATE ON public.licenses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: admin_profiles set_admin_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_admin_profiles_updated_at BEFORE UPDATE ON public.admin_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: app_settings set_app_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_app_settings_updated_at BEFORE UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cloud_table_snapshots trg_cleanup_cloud_table_snapshots; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cleanup_cloud_table_snapshots AFTER INSERT ON public.cloud_table_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.cleanup_cloud_table_snapshots();


--
-- Name: feature_flags trg_feature_flags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_feature_flags_updated_at BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cloud_table_snapshots trg_limit_cloud_table_snapshot_writes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_limit_cloud_table_snapshot_writes BEFORE INSERT ON public.cloud_table_snapshots FOR EACH ROW EXECUTE FUNCTION public.limit_cloud_table_snapshot_writes();


--
-- Name: memory_items trg_memory_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_memory_items_updated_at BEFORE UPDATE ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: memory_projects trg_memory_projects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_memory_projects_updated_at BEFORE UPDATE ON public.memory_projects FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: online_app_settings trg_online_app_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_online_app_settings_updated_at BEFORE UPDATE ON public.online_app_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: shoe_round_card_events trg_reject_v100_rank_event_evidence_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reject_v100_rank_event_evidence_mutation BEFORE DELETE OR UPDATE ON public.shoe_round_card_events FOR EACH ROW EXECUTE FUNCTION public.reject_v100_rank_event_evidence_mutation();


--
-- Name: admin_audit_logs admin_audit_logs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.memory_projects(id) ON DELETE SET NULL;


--
-- Name: admin_profiles admin_profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_profiles
    ADD CONSTRAINT admin_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agents agents_parent_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_parent_code_fkey FOREIGN KEY (parent_code) REFERENCES public.agents(code) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: feature_flags feature_flags_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.memory_projects(id) ON DELETE CASCADE;


--
-- Name: license_validation_logs license_validation_logs_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_validation_logs
    ADD CONSTRAINT license_validation_logs_license_id_fkey FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE SET NULL;


--
-- Name: licenses licenses_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT;


--
-- Name: licenses licenses_member_account_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_member_account_fkey FOREIGN KEY (member_account) REFERENCES public.members(account) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: licenses licenses_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: live_table_snapshots live_table_snapshots_source_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_table_snapshots
    ADD CONSTRAINT live_table_snapshots_source_license_id_fkey FOREIGN KEY (source_license_id) REFERENCES public.manager_licenses(id) ON DELETE SET NULL;


--
-- Name: manager_accounts manager_accounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manager_accounts
    ADD CONSTRAINT manager_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.manager_accounts(id) ON DELETE SET NULL;


--
-- Name: manager_licenses manager_licenses_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manager_licenses
    ADD CONSTRAINT manager_licenses_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.manager_accounts(id) ON DELETE RESTRICT;


--
-- Name: members members_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: memory_items memory_items_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_items
    ADD CONSTRAINT memory_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.memory_projects(id) ON DELETE CASCADE;


--
-- Name: memory_strategy_versions memory_strategy_versions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_strategy_versions
    ADD CONSTRAINT memory_strategy_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.memory_projects(id) ON DELETE CASCADE;


--
-- Name: memory_test_reports memory_test_reports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_test_reports
    ADD CONSTRAINT memory_test_reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.memory_projects(id) ON DELETE CASCADE;


--
-- Name: online_app_settings online_app_settings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.online_app_settings
    ADD CONSTRAINT online_app_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.memory_projects(id) ON DELETE CASCADE;


--
-- Name: admin_profiles Admins can read own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read own profile" ON public.admin_profiles FOR SELECT TO authenticated USING ((auth.uid() = id));


--
-- Name: model_versions Authenticated can read model versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read model versions" ON public.model_versions FOR SELECT TO authenticated USING (true);


--
-- Name: baccarat_tables Public can read active baccarat tables; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read active baccarat tables" ON public.baccarat_tables FOR SELECT TO authenticated, anon USING ((is_active = true));


--
-- Name: ai_strategy_versions Public can read active strategy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read active strategy" ON public.ai_strategy_versions FOR SELECT TO authenticated, anon USING ((status = 'active'::text));


--
-- Name: daily_prediction_results Public can read recent prediction results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read recent prediction results" ON public.daily_prediction_results FOR SELECT TO authenticated, anon USING ((created_at >= (now() - '1 day'::interval)));


--
-- Name: daily_roadmap_events Public can read recent roadmap events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read recent roadmap events" ON public.daily_roadmap_events FOR SELECT TO authenticated, anon USING ((opened_at >= (now() - '1 day'::interval)));


--
-- Name: app_settings Public can read safe app settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read safe app settings" ON public.app_settings FOR SELECT TO authenticated, anon USING ((key = ANY (ARRAY['active_strategy_version'::text, 'frontend_status'::text, 'retention_days'::text])));


--
-- Name: admin_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_operation_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_operation_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_strategy_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_strategy_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: plans anon can read active plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read active plans" ON public.plans FOR SELECT TO authenticated, anon USING (true);


--
-- Name: cloud_capture_status anon can read cloud_capture_status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read cloud_capture_status" ON public.cloud_capture_status FOR SELECT TO authenticated, anon USING (true);


--
-- Name: cloud_strategy_adjustment_stats anon can read cloud_strategy_adjustment_stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read cloud_strategy_adjustment_stats" ON public.cloud_strategy_adjustment_stats FOR SELECT TO authenticated, anon USING (true);


--
-- Name: cloud_strategy_reports anon can read cloud_strategy_reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read cloud_strategy_reports" ON public.cloud_strategy_reports FOR SELECT TO authenticated, anon USING (true);


--
-- Name: cloud_table_snapshots anon can read cloud_table_snapshots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read cloud_table_snapshots" ON public.cloud_table_snapshots FOR SELECT TO authenticated, anon USING (true);


--
-- Name: daily_prediction_results anon can read daily_prediction_results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read daily_prediction_results" ON public.daily_prediction_results FOR SELECT TO authenticated, anon USING (true);


--
-- Name: daily_roadmap_events anon can read daily_roadmap_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon can read daily_roadmap_events" ON public.daily_roadmap_events FOR SELECT TO authenticated, anon USING (true);


--
-- Name: app_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: baccarat_tables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baccarat_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_capture_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_capture_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_capture_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_capture_status ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_operational_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_operational_events ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_strategy_adjustment_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_strategy_adjustment_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_strategy_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_strategy_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_table_rounds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_table_rounds ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_table_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_table_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_prediction_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_prediction_results ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_roadmap_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_roadmap_events ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: license_validation_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.license_validation_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: licenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

--
-- Name: live_table_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.live_table_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: manager_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.manager_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: manager_licenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.manager_licenses ENABLE ROW LEVEL SECURITY;

--
-- Name: members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_items ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_strategy_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_strategy_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_test_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_test_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: model_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.model_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: online_app_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.online_app_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags public read enabled feature flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read enabled feature flags" ON public.feature_flags FOR SELECT USING ((enabled = true));


--
-- Name: memory_projects public read memory projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read memory projects" ON public.memory_projects FOR SELECT USING ((status = 'active'::text));


--
-- Name: online_app_settings public read public app settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read public app settings" ON public.online_app_settings FOR SELECT USING ((is_public = true));


--
-- Name: schema_migration_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schema_migration_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: cloud_operational_events service role can manage cloud operational events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud operational events" ON public.cloud_operational_events TO service_role USING (true) WITH CHECK (true);


--
-- Name: cloud_capture_sessions service role can manage cloud_capture_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud_capture_sessions" ON public.cloud_capture_sessions TO service_role USING (true) WITH CHECK (true);


--
-- Name: cloud_capture_status service role can manage cloud_capture_status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud_capture_status" ON public.cloud_capture_status TO service_role USING (true) WITH CHECK (true);


--
-- Name: cloud_strategy_adjustment_stats service role can manage cloud_strategy_adjustment_stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud_strategy_adjustment_stats" ON public.cloud_strategy_adjustment_stats TO service_role USING (true) WITH CHECK (true);


--
-- Name: cloud_strategy_reports service role can manage cloud_strategy_reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud_strategy_reports" ON public.cloud_strategy_reports TO service_role USING (true) WITH CHECK (true);


--
-- Name: cloud_table_rounds service role can manage cloud_table_rounds; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud_table_rounds" ON public.cloud_table_rounds TO service_role USING (true) WITH CHECK (true);


--
-- Name: cloud_table_snapshots service role can manage cloud_table_snapshots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage cloud_table_snapshots" ON public.cloud_table_snapshots TO service_role USING (true) WITH CHECK (true);


--
-- Name: daily_prediction_results service role can manage daily_prediction_results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage daily_prediction_results" ON public.daily_prediction_results TO service_role USING (true) WITH CHECK (true);


--
-- Name: daily_roadmap_events service role can manage daily_roadmap_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage daily_roadmap_events" ON public.daily_roadmap_events TO service_role USING (true) WITH CHECK (true);


--
-- Name: schema_migration_versions service role can manage schema migration versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role can manage schema migration versions" ON public.schema_migration_versions TO service_role USING (true) WITH CHECK (true);


--
-- Name: admin_operation_logs service role manages admin_operation_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages admin_operation_logs" ON public.admin_operation_logs TO service_role USING (true) WITH CHECK (true);


--
-- Name: agents service role manages agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages agents" ON public.agents TO service_role USING (true) WITH CHECK (true);


--
-- Name: license_validation_logs service role manages license_validation_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages license_validation_logs" ON public.license_validation_logs TO service_role USING (true) WITH CHECK (true);


--
-- Name: licenses service role manages licenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages licenses" ON public.licenses TO service_role USING (true) WITH CHECK (true);


--
-- Name: manager_accounts service role manages manager_accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages manager_accounts" ON public.manager_accounts TO service_role USING (true) WITH CHECK (true);


--
-- Name: members service role manages members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages members" ON public.members TO service_role USING (true) WITH CHECK (true);


--
-- Name: plans service role manages plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages plans" ON public.plans TO service_role USING (true) WITH CHECK (true);


--
-- Name: shoe_rank_ledgers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shoe_rank_ledgers ENABLE ROW LEVEL SECURITY;

--
-- Name: shoe_round_card_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shoe_round_card_events ENABLE ROW LEVEL SECURITY;

--
-- Name: v100_formal_release_previous_active; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.v100_formal_release_previous_active ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION apply_v100_rank_ledger_event(p_event jsonb, p_ledger jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_v100_rank_ledger_event(p_event jsonb, p_ledger jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_v100_rank_ledger_event(p_event jsonb, p_ledger jsonb) TO service_role;


--
-- Name: FUNCTION cleanup_cloud_table_snapshots(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cleanup_cloud_table_snapshots() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cleanup_cloud_table_snapshots() TO service_role;


--
-- Name: FUNCTION cleanup_short_retention_data(retention interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cleanup_short_retention_data(retention interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cleanup_short_retention_data(retention interval) TO service_role;


--
-- Name: FUNCTION compact_cloud_table_snapshots(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.compact_cloud_table_snapshots() FROM PUBLIC;
GRANT ALL ON FUNCTION public.compact_cloud_table_snapshots() TO service_role;


--
-- Name: FUNCTION get_v100_prediction_lifecycle_stats(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_v100_prediction_lifecycle_stats() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_v100_prediction_lifecycle_stats() TO service_role;


--
-- Name: FUNCTION issue_v100_prediction(p_prediction jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.issue_v100_prediction(p_prediction jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_v100_prediction(p_prediction jsonb) TO service_role;


--
-- Name: FUNCTION limit_cloud_table_snapshot_writes(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.limit_cloud_table_snapshot_writes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.limit_cloud_table_snapshot_writes() TO service_role;


--
-- Name: FUNCTION persist_latest_cloud_table_snapshot(p_snapshot jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.persist_latest_cloud_table_snapshot(p_snapshot jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.persist_latest_cloud_table_snapshot(p_snapshot jsonb) TO service_role;


--
-- Name: FUNCTION persist_v100_settled_round(p_roadmap jsonb, p_prediction jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.persist_v100_settled_round(p_roadmap jsonb, p_prediction jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.persist_v100_settled_round(p_roadmap jsonb, p_prediction jsonb) TO service_role;


--
-- Name: FUNCTION purge_expired_manager_licenses(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.purge_expired_manager_licenses() FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_expired_manager_licenses() TO service_role;


--
-- Name: FUNCTION reconcile_v100_prediction_lifecycle(p_source text, p_table_id text, p_current_shoe text, p_current_visible_round integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_v100_prediction_lifecycle(p_source text, p_table_id text, p_current_shoe text, p_current_visible_round integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reconcile_v100_prediction_lifecycle(p_source text, p_table_id text, p_current_shoe text, p_current_visible_round integer) TO service_role;


--
-- Name: FUNCTION reject_v100_rank_event_evidence_mutation(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reject_v100_rank_event_evidence_mutation() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_v100_rank_event_evidence_mutation() TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION settle_v100_prediction(p_roadmap jsonb, p_settlement jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.settle_v100_prediction(p_roadmap jsonb, p_settlement jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.settle_v100_prediction(p_roadmap jsonb, p_settlement jsonb) TO service_role;


--
-- Name: FUNCTION touch_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_updated_at() TO service_role;


--
-- Name: TABLE admin_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_audit_logs TO anon;
GRANT ALL ON TABLE public.admin_audit_logs TO authenticated;
GRANT ALL ON TABLE public.admin_audit_logs TO service_role;


--
-- Name: SEQUENCE admin_audit_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.admin_audit_logs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.admin_audit_logs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.admin_audit_logs_id_seq TO service_role;


--
-- Name: TABLE admin_operation_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_operation_logs TO anon;
GRANT ALL ON TABLE public.admin_operation_logs TO authenticated;
GRANT ALL ON TABLE public.admin_operation_logs TO service_role;


--
-- Name: TABLE admin_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_profiles TO anon;
GRANT ALL ON TABLE public.admin_profiles TO authenticated;
GRANT ALL ON TABLE public.admin_profiles TO service_role;


--
-- Name: TABLE agents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agents TO anon;
GRANT ALL ON TABLE public.agents TO authenticated;
GRANT ALL ON TABLE public.agents TO service_role;


--
-- Name: TABLE ai_strategy_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_strategy_versions TO anon;
GRANT ALL ON TABLE public.ai_strategy_versions TO authenticated;
GRANT ALL ON TABLE public.ai_strategy_versions TO service_role;


--
-- Name: TABLE app_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_settings TO anon;
GRANT ALL ON TABLE public.app_settings TO authenticated;
GRANT ALL ON TABLE public.app_settings TO service_role;


--
-- Name: TABLE baccarat_tables; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.baccarat_tables TO anon;
GRANT ALL ON TABLE public.baccarat_tables TO authenticated;
GRANT ALL ON TABLE public.baccarat_tables TO service_role;


--
-- Name: TABLE cloud_capture_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_capture_sessions TO anon;
GRANT ALL ON TABLE public.cloud_capture_sessions TO authenticated;
GRANT ALL ON TABLE public.cloud_capture_sessions TO service_role;


--
-- Name: TABLE cloud_capture_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_capture_status TO anon;
GRANT ALL ON TABLE public.cloud_capture_status TO authenticated;
GRANT ALL ON TABLE public.cloud_capture_status TO service_role;


--
-- Name: TABLE cloud_operational_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_operational_events TO anon;
GRANT ALL ON TABLE public.cloud_operational_events TO authenticated;
GRANT ALL ON TABLE public.cloud_operational_events TO service_role;


--
-- Name: SEQUENCE cloud_operational_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.cloud_operational_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.cloud_operational_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.cloud_operational_events_id_seq TO service_role;


--
-- Name: TABLE cloud_strategy_adjustment_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_strategy_adjustment_stats TO anon;
GRANT ALL ON TABLE public.cloud_strategy_adjustment_stats TO authenticated;
GRANT ALL ON TABLE public.cloud_strategy_adjustment_stats TO service_role;


--
-- Name: TABLE cloud_strategy_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_strategy_reports TO anon;
GRANT ALL ON TABLE public.cloud_strategy_reports TO authenticated;
GRANT ALL ON TABLE public.cloud_strategy_reports TO service_role;


--
-- Name: TABLE cloud_table_rounds; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_table_rounds TO anon;
GRANT ALL ON TABLE public.cloud_table_rounds TO authenticated;
GRANT ALL ON TABLE public.cloud_table_rounds TO service_role;


--
-- Name: TABLE cloud_table_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloud_table_snapshots TO anon;
GRANT ALL ON TABLE public.cloud_table_snapshots TO authenticated;
GRANT ALL ON TABLE public.cloud_table_snapshots TO service_role;


--
-- Name: TABLE daily_prediction_results; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.daily_prediction_results TO anon;
GRANT ALL ON TABLE public.daily_prediction_results TO authenticated;
GRANT ALL ON TABLE public.daily_prediction_results TO service_role;


--
-- Name: TABLE daily_roadmap_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.daily_roadmap_events TO anon;
GRANT ALL ON TABLE public.daily_roadmap_events TO authenticated;
GRANT ALL ON TABLE public.daily_roadmap_events TO service_role;


--
-- Name: TABLE feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.feature_flags TO anon;
GRANT ALL ON TABLE public.feature_flags TO authenticated;
GRANT ALL ON TABLE public.feature_flags TO service_role;


--
-- Name: TABLE license_validation_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.license_validation_logs TO anon;
GRANT ALL ON TABLE public.license_validation_logs TO authenticated;
GRANT ALL ON TABLE public.license_validation_logs TO service_role;


--
-- Name: SEQUENCE license_validation_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.license_validation_logs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.license_validation_logs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.license_validation_logs_id_seq TO service_role;


--
-- Name: TABLE licenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.licenses TO anon;
GRANT ALL ON TABLE public.licenses TO authenticated;
GRANT ALL ON TABLE public.licenses TO service_role;


--
-- Name: TABLE live_table_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.live_table_snapshots TO anon;
GRANT ALL ON TABLE public.live_table_snapshots TO authenticated;
GRANT ALL ON TABLE public.live_table_snapshots TO service_role;


--
-- Name: TABLE manager_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.manager_accounts TO anon;
GRANT ALL ON TABLE public.manager_accounts TO authenticated;
GRANT ALL ON TABLE public.manager_accounts TO service_role;


--
-- Name: TABLE manager_licenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.manager_licenses TO anon;
GRANT ALL ON TABLE public.manager_licenses TO authenticated;
GRANT ALL ON TABLE public.manager_licenses TO service_role;


--
-- Name: TABLE members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.members TO anon;
GRANT ALL ON TABLE public.members TO authenticated;
GRANT ALL ON TABLE public.members TO service_role;


--
-- Name: TABLE memory_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_items TO anon;
GRANT ALL ON TABLE public.memory_items TO authenticated;
GRANT ALL ON TABLE public.memory_items TO service_role;


--
-- Name: TABLE memory_projects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_projects TO anon;
GRANT ALL ON TABLE public.memory_projects TO authenticated;
GRANT ALL ON TABLE public.memory_projects TO service_role;


--
-- Name: TABLE memory_strategy_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_strategy_versions TO anon;
GRANT ALL ON TABLE public.memory_strategy_versions TO authenticated;
GRANT ALL ON TABLE public.memory_strategy_versions TO service_role;


--
-- Name: TABLE memory_test_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_test_reports TO anon;
GRANT ALL ON TABLE public.memory_test_reports TO authenticated;
GRANT ALL ON TABLE public.memory_test_reports TO service_role;


--
-- Name: TABLE model_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.model_versions TO anon;
GRANT ALL ON TABLE public.model_versions TO authenticated;
GRANT ALL ON TABLE public.model_versions TO service_role;


--
-- Name: TABLE online_app_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.online_app_settings TO anon;
GRANT ALL ON TABLE public.online_app_settings TO authenticated;
GRANT ALL ON TABLE public.online_app_settings TO service_role;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.plans TO anon;
GRANT ALL ON TABLE public.plans TO authenticated;
GRANT ALL ON TABLE public.plans TO service_role;


--
-- Name: TABLE schema_migration_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schema_migration_versions TO anon;
GRANT ALL ON TABLE public.schema_migration_versions TO authenticated;
GRANT ALL ON TABLE public.schema_migration_versions TO service_role;


--
-- Name: TABLE shoe_rank_ledgers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.shoe_rank_ledgers TO service_role;


--
-- Name: TABLE shoe_round_card_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.shoe_round_card_events TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--


-- Canonical v100 strategy and migration ledger seeds.
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.7

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: ai_strategy_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ai_strategy_versions (id, version, status, learned_from_date, sample_count, total_hit_rate, high_confidence_hit_rate, weights, metrics, notes, created_at, activated_at) VALUES ('7d62fb72-eb42-4947-bbfe-f9d1307b3dee', 'v100', 'active', NULL, 0, NULL, NULL, '{"shoe": 0, "state": 0, "big_road": 0, "bead_road": 0, "tie_count": 0, "confidence": 0, "shoe_stage": 0, "small_road": 0, "table_type": 0, "card_points": 0, "banker_count": 0, "big_eye_road": 0, "player_count": 0, "streak_length": 0, "total_players": 0, "cockroach_road": 0, "previous_winner": 0, "probability_gap": 0, "ask_road_signals": 0.25, "next_banker_road": 0, "next_player_road": 0, "source_updated_at": 0, "historical_backtest": 0, "direction_calibration": 0, "roadmap_trend_signals": 0.45, "shoe_remaining_points": 0, "table_recent_hit_rate": 0, "road_structure_signals": 0, "shoe_banker_player_bias": 0.1, "near5_banker_player_bias": 0, "recent_practical_calibration": 0.2, "derived_road_structure_signals": 0}', '{"mode": "formal_live_prediction", "auto_adjust": false, "description": "v100正式整合包；主預測採靴內偏移去重，副預測採訊號去重與固定8副牌牌階Ledger，沿用核准門檻。", "rank_ledger": "durable_eight_deck_exact_rank_ledger", "main_weights": {"shoe": 0, "state": 0, "big_road": 0, "bead_road": 0, "tie_count": 0, "confidence": 0, "shoe_stage": 0, "small_road": 0, "table_type": 0, "card_points": 0, "banker_count": 0, "big_eye_road": 0, "player_count": 0, "streak_length": 0, "total_players": 0, "cockroach_road": 0, "previous_winner": 0, "probability_gap": 0, "ask_road_signals": 0.25, "next_banker_road": 0, "next_player_road": 0, "source_updated_at": 0, "historical_backtest": 0, "direction_calibration": 0, "roadmap_trend_signals": 0.45, "shoe_remaining_points": 0, "table_recent_hit_rate": 0, "road_structure_signals": 0, "shoe_banker_player_bias": 0.1, "near5_banker_player_bias": 0, "recent_practical_calibration": 0.2, "derived_road_structure_signals": 0}, "side_weights": {"tie": {"shoe": 0, "round": 0, "big_road": 0, "tie_risk": 0.45, "bead_road": 0, "pair_risk": 0, "super_six": 0, "tie_count": 0.1, "point_diff": 0, "road_chaos": 0.15, "shoe_stage": 0.1, "small_road": 0, "banker_point": 0, "big_eye_road": 0, "player_point": 0, "banker_dragon": 0, "player_dragon": 0, "banker_natural": 0, "cockroach_road": 0, "player_natural": 0, "next_banker_road": 0, "next_player_road": 0, "ask_road_conflict": 0, "banker_pair_count": 0, "player_pair_count": 0, "table_side_history": 0, "remaining_rank_total": 0.2, "remaining_rank_pressure": 0}, "superSix": {"shoe": 0, "round": 0, "big_road": 0, "tie_risk": 0, "bead_road": 0, "pair_risk": 0, "super_six": 0, "tie_count": 0, "point_diff": 0, "road_chaos": 0, "shoe_stage": 0.1, "small_road": 0, "banker_point": 0.35, "big_eye_road": 0, "player_point": 0, "banker_dragon": 0, "player_dragon": 0, "banker_natural": 0, "cockroach_road": 0, "player_natural": 0, "next_banker_road": 0, "next_player_road": 0, "ask_road_conflict": 0, "banker_pair_count": 0, "player_pair_count": 0, "table_side_history": 0.35, "remaining_rank_total": 0.2, "remaining_rank_pressure": 0}, "bankerPair": {"shoe": 0, "round": 0, "big_road": 0, "tie_risk": 0, "bead_road": 0, "pair_risk": 0.35, "super_six": 0, "tie_count": 0, "point_diff": 0, "road_chaos": 0, "shoe_stage": 0.2, "small_road": 0, "banker_point": 0, "big_eye_road": 0, "player_point": 0, "banker_dragon": 0, "player_dragon": 0, "banker_natural": 0, "cockroach_road": 0, "player_natural": 0, "next_banker_road": 0, "next_player_road": 0, "ask_road_conflict": 0, "banker_pair_count": 0.2, "player_pair_count": 0, "table_side_history": 0.1, "remaining_rank_total": 0, "remaining_rank_pressure": 0.15}, "playerPair": {"shoe": 0, "round": 0, "big_road": 0, "tie_risk": 0, "bead_road": 0, "pair_risk": 0.25, "super_six": 0, "tie_count": 0, "point_diff": 0, "road_chaos": 0, "shoe_stage": 0.15, "small_road": 0, "banker_point": 0, "big_eye_road": 0, "player_point": 0, "banker_dragon": 0, "player_dragon": 0, "banker_natural": 0, "cockroach_road": 0, "player_natural": 0, "next_banker_road": 0, "next_player_road": 0, "ask_road_conflict": 0, "banker_pair_count": 0, "player_pair_count": 0.2, "table_side_history": 0.2, "remaining_rank_total": 0, "remaining_rank_pressure": 0.2}, "bankerDragon": {"shoe": 0, "round": 0, "big_road": 0.1, "tie_risk": 0, "bead_road": 0, "pair_risk": 0, "super_six": 0, "tie_count": 0, "point_diff": 0.15, "road_chaos": 0, "shoe_stage": 0, "small_road": 0, "banker_point": 0.35, "big_eye_road": 0, "player_point": 0, "banker_dragon": 0, "player_dragon": 0, "banker_natural": 0.1, "cockroach_road": 0, "player_natural": 0, "next_banker_road": 0, "next_player_road": 0, "ask_road_conflict": 0, "banker_pair_count": 0, "player_pair_count": 0, "table_side_history": 0, "remaining_rank_total": 0.3, "remaining_rank_pressure": 0}, "playerDragon": {"shoe": 0, "round": 0, "big_road": 0.1, "tie_risk": 0, "bead_road": 0, "pair_risk": 0, "super_six": 0, "tie_count": 0, "point_diff": 0.15, "road_chaos": 0, "shoe_stage": 0, "small_road": 0, "banker_point": 0, "big_eye_road": 0, "player_point": 0.35, "banker_dragon": 0, "player_dragon": 0, "banker_natural": 0, "cockroach_road": 0, "player_natural": 0.1, "next_banker_road": 0, "next_player_road": 0, "ask_road_conflict": 0, "banker_pair_count": 0, "player_pair_count": 0, "table_side_history": 0, "remaining_rank_total": 0.3, "remaining_rank_pressure": 0}}, "main_strategy": "v100_主預測靴內偏移去重版", "side_strategy": "v100_主副訊號去重與8副牌階完整性版", "side_thresholds": {"tie": 25, "superSix": 45, "bankerPair": 43, "playerPair": 43, "bankerDragon": 30, "playerDragon": 30}}', 'Only active runtime strategy and history source for formal release v100.', '2026-07-17 19:40:06.149462+00', '2026-07-17 19:40:06.149462+00');


--
-- Data for Name: schema_migration_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_migration_versions (version, description, applied_at, metadata) VALUES ('v100-baseline', 'v100 latest-only consolidated production baseline', '2026-07-18 08:30:26.778184+00', '{"history_removed": true, "strategy_version": "v100"}');


--
-- PostgreSQL database dump complete
--
