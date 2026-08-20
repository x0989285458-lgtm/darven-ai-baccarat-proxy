begin;

-- Formal.13 makes mutable capture projections monotonic and atomic per durable
-- envelope sequence. An old Outbox retry may complete, but it can never regress
-- the latest status or table snapshot written by a newer sequence.
create or replace function public.persist_v105_capture_ancillary_projection(p_projection jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  projection_session text := nullif(p_projection->>'session_id', '');
  projection_sequence bigint;
  projection_captured_at timestamptz;
  projection_status jsonb := coalesce(p_projection->'status', '{}'::jsonb);
  projection_snapshot jsonb := coalesce(p_projection->'snapshot', '{}'::jsonb);
  projection_status_metadata jsonb;
  projection_snapshot_metadata jsonb;
  current_status_sequence bigint;
  current_snapshot_sequence bigint;
  current_status_captured_at timestamptz;
  current_snapshot_captured_at timestamptz;
  current_sequence bigint;
  current_captured_at timestamptz;
  status_id uuid;
  snapshot_id uuid;
begin
  if projection_session is null then
    raise exception 'projection session_id is required';
  end if;
  begin
    projection_sequence := nullif(p_projection->>'sequence', '')::bigint;
  exception when others then
    raise exception 'projection sequence is invalid';
  end;
  if projection_sequence is null or projection_sequence < 1 then
    raise exception 'projection sequence is required';
  end if;
  begin
    projection_captured_at := nullif(p_projection->>'captured_at', '')::timestamptz;
  exception when others then
    raise exception 'projection captured_at is invalid';
  end;
  if projection_captured_at is null then
    raise exception 'projection captured_at is required';
  end if;
  if jsonb_typeof(projection_status) <> 'object' then
    raise exception 'projection status must be an object';
  end if;
  if jsonb_typeof(projection_snapshot) <> 'object'
     or jsonb_typeof(coalesce(projection_snapshot->'tables', 'null'::jsonb)) <> 'array' then
    raise exception 'projection snapshot tables must be an array';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('v105_capture_projection:' || projection_session, 0));

  select nullif(metadata->>'sequence', '')::bigint,
         nullif(metadata->>'capturedAt', '')::timestamptz
    into current_status_sequence, current_status_captured_at
  from public.cloud_capture_status
  where session_id is not distinct from projection_session
  for update;

  select nullif(metadata->>'sequence', '')::bigint,
         coalesce(nullif(metadata->>'capturedAt', '')::timestamptz, snapshot_at)
    into current_snapshot_sequence, current_snapshot_captured_at
  from public.cloud_table_snapshots
  where session_id is not distinct from projection_session
  order by snapshot_at desc
  limit 1
  for update;

  current_sequence := greatest(
    coalesce(current_status_sequence, -1),
    coalesce(current_snapshot_sequence, -1)
  );
  current_captured_at := greatest(
    coalesce(current_status_captured_at, '-infinity'::timestamptz),
    coalesce(current_snapshot_captured_at, '-infinity'::timestamptz)
  );

  if projection_sequence < greatest(
       coalesce(current_status_sequence, -1),
       coalesce(current_snapshot_sequence, -1)
     ) then
    return jsonb_build_object('persisted', false, 'skipped', true, 'reason', 'stale_sequence', 'sequence', projection_sequence, 'current_sequence', current_sequence);
  end if;
  if projection_captured_at < current_captured_at then
    return jsonb_build_object('persisted', false, 'skipped', true, 'reason', 'stale_capture_time', 'sequence', projection_sequence, 'current_sequence', current_sequence);
  end if;

  projection_status_metadata := coalesce(projection_status->'metadata', '{}'::jsonb)
    || jsonb_build_object('sequence', projection_sequence, 'capturedAt', projection_captured_at);
  projection_snapshot_metadata := coalesce(projection_snapshot->'metadata', '{}'::jsonb)
    || jsonb_build_object('sequence', projection_sequence, 'capturedAt', projection_captured_at);

  update public.cloud_capture_status
  set capture_source = coalesce(nullif(projection_status->>'capture_source', ''), 'offline'),
      deploy_mode = nullif(projection_status->>'deploy_mode', ''),
      connected = coalesce((projection_status->>'connected')::boolean, false),
      authenticated = coalesce((projection_status->>'authenticated')::boolean, false),
      table_count = coalesce(nullif(projection_status->>'table_count', '')::integer, 0),
      last_message_at = nullif(projection_status->>'last_message_at', '')::timestamptz,
      last_round_at = nullif(projection_status->>'last_round_at', '')::timestamptz,
      status_text = nullif(projection_status->>'status_text', ''),
      error_message = nullif(projection_status->>'error_message', ''),
      metadata = projection_status_metadata,
      updated_at = now()
  where session_id is not distinct from projection_session
  returning id into status_id;

  if not found then
    insert into public.cloud_capture_status(
      session_id, capture_source, deploy_mode, connected, authenticated, table_count,
      last_message_at, last_round_at, status_text, error_message, metadata, updated_at
    ) values (
      projection_session,
      coalesce(nullif(projection_status->>'capture_source', ''), 'offline'),
      nullif(projection_status->>'deploy_mode', ''),
      coalesce((projection_status->>'connected')::boolean, false),
      coalesce((projection_status->>'authenticated')::boolean, false),
      coalesce(nullif(projection_status->>'table_count', '')::integer, 0),
      nullif(projection_status->>'last_message_at', '')::timestamptz,
      nullif(projection_status->>'last_round_at', '')::timestamptz,
      nullif(projection_status->>'status_text', ''),
      nullif(projection_status->>'error_message', ''),
      projection_status_metadata,
      now()
    ) returning id into status_id;
  end if;

  update public.cloud_table_snapshots
  set capture_source = coalesce(nullif(projection_snapshot->>'capture_source', ''), 'offline'),
      table_count = coalesce(nullif(projection_snapshot->>'table_count', '')::integer, jsonb_array_length(projection_snapshot->'tables')),
      tables = projection_snapshot->'tables',
      table_summary = '[]'::jsonb,
      snapshot_at = projection_captured_at,
      metadata = projection_snapshot_metadata
  where id = (
    select id from public.cloud_table_snapshots
    where session_id is not distinct from projection_session
    order by snapshot_at desc
    limit 1
  )
  returning id into snapshot_id;

  if not found then
    insert into public.cloud_table_snapshots(
      session_id, capture_source, table_count, tables, table_summary, snapshot_at, metadata
    ) values (
      projection_session,
      coalesce(nullif(projection_snapshot->>'capture_source', ''), 'offline'),
      coalesce(nullif(projection_snapshot->>'table_count', '')::integer, jsonb_array_length(projection_snapshot->'tables')),
      projection_snapshot->'tables',
      '[]'::jsonb,
      projection_captured_at,
      projection_snapshot_metadata
    ) returning id into snapshot_id;
  end if;

  return jsonb_build_object(
    'persisted', true,
    'skipped', false,
    'sequence', projection_sequence,
    'captured_at', projection_captured_at,
    'status_id', status_id,
    'snapshot_id', snapshot_id
  );
end;
$$;

revoke all on function public.persist_v105_capture_ancillary_projection(jsonb) from public, anon, authenticated;
grant execute on function public.persist_v105_capture_ancillary_projection(jsonb) to service_role;

commit;
