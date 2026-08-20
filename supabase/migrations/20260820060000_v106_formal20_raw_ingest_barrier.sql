-- Formal.20 closes the legacy direct Raw-ingest rollback race. Every inner
-- persistence call now participates in the same shared advisory barrier as the
-- fenced wrapper; rollback terminalization takes the exclusive form. Direct
-- service-role execution is removed so production ingress uses only the fenced RPC.
begin;

create or replace function public.persist_v105_capture_envelope(p_capture jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  capture_session text := nullif(p_capture->>'session_id', '');
  capture_sequence bigint;
  capture_round_keys jsonb := coalesce(p_capture->'round_keys', '[]'::jsonb);
  capture_rounds jsonb := coalesce(p_capture->'rounds', '[]'::jsonb);
  capture_snapshot jsonb := coalesce(p_capture->'snapshot', '{}'::jsonb);
  capture_status jsonb := coalesce(p_capture->'status', '{}'::jsonb);
  canonical_payload_hash text;
  existing_payload_hash text;
  existing_payload jsonb;
  existing_round_keys jsonb;
  current_latest_sequence bigint;
  conflict_found boolean := false;
begin
  perform pg_catalog.set_config('lock_timeout', '5000', true);
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('v105_capture_source_fence:capture', 0));
  if capture_session is null then raise exception 'capture session_id is required'; end if;
  begin
    capture_sequence := (p_capture->>'sequence')::bigint;
  exception when others then
    raise exception 'capture sequence is required';
  end;
  if capture_sequence < 1 then raise exception 'capture sequence must be positive'; end if;
  if pg_catalog.jsonb_typeof(capture_round_keys) <> 'array' then raise exception 'capture round_keys must be an array'; end if;
  if pg_catalog.jsonb_typeof(capture_rounds) <> 'array' then raise exception 'capture rounds must be an array'; end if;
  if pg_catalog.jsonb_typeof(capture_snapshot) <> 'object' then raise exception 'capture snapshot must be an object'; end if;
  if pg_catalog.jsonb_typeof(capture_status) <> 'object' then raise exception 'capture status must be an object'; end if;
  if pg_catalog.jsonb_array_length(capture_round_keys) <> pg_catalog.jsonb_array_length(capture_rounds) then
    raise exception 'capture round key count mismatch';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(capture_rounds) with ordinality as item(round_row, ordinality)
    where capture_round_keys->>((item.ordinality - 1)::integer)
      is distinct from pg_catalog.concat(item.round_row->>'table_id', ':', item.round_row->>'shoe_no', ':', item.round_row->>'round_no')
  ) then
    raise exception 'capture round key identity mismatch';
  end if;

  canonical_payload_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_capture::text, 'UTF8'), 'sha256'),
    'hex'
  );

  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(capture_session, 0)) then
    raise exception 'capture_lock_busy_retry' using errcode = '55P03';
  end if;

  select outbox.payload_hash, outbox.payload, outbox.round_keys
    into existing_payload_hash, existing_payload, existing_round_keys
  from public.v105_capture_settlement_outbox as outbox
  where outbox.session_id = capture_session and outbox.sequence = capture_sequence
  for update nowait;

  if found then
    if existing_payload_hash is distinct from canonical_payload_hash
       or existing_payload is distinct from p_capture
       or existing_round_keys is distinct from capture_round_keys then
      raise exception 'capture identity conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'persisted', true, 'duplicate', true, 'session_id', capture_session,
      'sequence', capture_sequence, 'accepted_round_keys', existing_round_keys,
      'payload_hash', existing_payload_hash
    );
  end if;

  select sessions.latest_sequence into current_latest_sequence
  from public.v105_capture_ingest_sessions as sessions
  where sessions.session_id = capture_session
  for update nowait;
  if current_latest_sequence is not null and capture_sequence <= current_latest_sequence then
    raise exception 'capture identity conflict';
  end if;

  select exists (
    select 1
    from pg_catalog.jsonb_to_recordset(capture_rounds) as incoming(
      session_id text, source text, table_id text, table_name text, shoe_no text, round_no integer,
      main_result text, banker_points integer, player_points integer, raw_event jsonb,
      table_snapshot jsonb, received_at timestamptz, metadata jsonb
    )
    join public.cloud_table_rounds as existing
      on existing.source = incoming.source
     and existing.table_id = incoming.table_id
     and existing.shoe_no = incoming.shoe_no
     and existing.round_no = incoming.round_no
    where existing.main_result is distinct from incoming.main_result
       or existing.banker_points is distinct from incoming.banker_points
       or existing.player_points is distinct from incoming.player_points
       or existing.raw_event is distinct from incoming.raw_event
       or existing.table_snapshot is distinct from incoming.table_snapshot
  ) into conflict_found;
  if conflict_found then raise exception 'capture identity conflict'; end if;

  insert into public.cloud_table_rounds (
    session_id, source, table_id, table_name, shoe_no, round_no, main_result,
    banker_points, player_points, raw_event, table_snapshot, received_at, metadata
  )
  select incoming.session_id, incoming.source, incoming.table_id, incoming.table_name, incoming.shoe_no, incoming.round_no,
    incoming.main_result, incoming.banker_points, incoming.player_points, incoming.raw_event,
    incoming.table_snapshot, incoming.received_at, coalesce(incoming.metadata, '{}'::jsonb)
  from pg_catalog.jsonb_to_recordset(capture_rounds) as incoming(
    session_id text, source text, table_id text, table_name text, shoe_no text, round_no integer,
    main_result text, banker_points integer, player_points integer, raw_event jsonb,
    table_snapshot jsonb, received_at timestamptz, metadata jsonb
  )
  on conflict (source, table_id, shoe_no, round_no) do nothing;

  insert into public.v105_capture_settlement_outbox (session_id, sequence, round_keys, payload, payload_hash)
  values (capture_session, capture_sequence, capture_round_keys, p_capture, canonical_payload_hash);

  insert into public.v105_capture_ingest_sessions (session_id, latest_sequence, updated_at)
  values (capture_session, capture_sequence, pg_catalog.now())
  on conflict (session_id) do update
  set latest_sequence = excluded.latest_sequence, updated_at = excluded.updated_at
  where public.v105_capture_ingest_sessions.latest_sequence < excluded.latest_sequence;

  return pg_catalog.jsonb_build_object(
    'persisted', true, 'duplicate', false, 'session_id', capture_session,
    'sequence', capture_sequence, 'accepted_round_keys', capture_round_keys,
    'payload_hash', canonical_payload_hash
  );
exception when lock_not_available then
  raise exception 'capture_lock_busy_retry' using errcode = '55P03';
end;
$$;

revoke execute on function public.persist_v105_capture_envelope(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.persist_v105_fenced_capture_envelope(jsonb) to service_role;

commit;
