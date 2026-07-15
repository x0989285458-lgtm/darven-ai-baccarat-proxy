begin;

create or replace function public.persist_latest_cloud_table_snapshot(p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.persist_latest_cloud_table_snapshot(jsonb) from public;
grant execute on function public.persist_latest_cloud_table_snapshot(jsonb) to service_role;

create or replace function public.compact_cloud_table_snapshots()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rows_before bigint;
  rows_after bigint;
begin
  lock table public.cloud_table_snapshots in access exclusive mode;
  select count(*) into rows_before from public.cloud_table_snapshots;

  create temporary table v09813_latest_snapshots on commit drop as
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
  from v09813_latest_snapshots;

  get diagnostics rows_after = row_count;
  return jsonb_build_object(
    'compacted', true,
    'rowsBefore', rows_before,
    'rowsAfter', rows_after,
    'rowsRemoved', rows_before - rows_after
  );
end;
$$;

revoke all on function public.compact_cloud_table_snapshots() from public;
grant execute on function public.compact_cloud_table_snapshots() to service_role;

commit;
