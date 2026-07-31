begin;

create table if not exists public.v105_capture_source_fence (
  scope text primary key default 'capture' check (scope = 'capture'),
  mode text not null check (mode in ('api', 'browser', 'replay')),
  owner_id text not null check (owner_id <> ''),
  epoch bigint not null check (epoch between 1 and 9007199254740991),
  fence text not null check (fence <> ''),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create or replace function public.persist_v105_fenced_capture_envelope(p_capture jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  capture_source jsonb;
  source_mode text;
  source_owner_id text;
  source_epoch bigint;
  source_fence text;
  current_fence public.v105_capture_source_fence%rowtype;
  acknowledgement jsonb;
begin
  if p_capture is null or pg_catalog.jsonb_typeof(p_capture) <> 'object' then
    raise exception 'source_fence_invalid';
  end if;
  capture_source := p_capture->'source';
  if capture_source is null or pg_catalog.jsonb_typeof(capture_source) is distinct from 'object' then
    raise exception 'source_fence_invalid';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(capture_source)) <> 4
     or pg_catalog.jsonb_typeof(capture_source->'mode') is distinct from 'string'
     or pg_catalog.jsonb_typeof(capture_source->'ownerId') is distinct from 'string'
     or pg_catalog.jsonb_typeof(capture_source->'epoch') is distinct from 'number'
     or pg_catalog.jsonb_typeof(capture_source->'fence') is distinct from 'string' then
    raise exception 'source_fence_invalid';
  end if;

  source_mode := capture_source->>'mode';
  source_owner_id := capture_source->>'ownerId';
  source_fence := capture_source->>'fence';
  if source_mode not in ('api', 'browser', 'replay')
     or source_owner_id is null or pg_catalog.btrim(source_owner_id) = ''
     or source_fence is null or pg_catalog.btrim(source_fence) = ''
     or (capture_source->>'epoch') !~ '^[1-9][0-9]*$' then
    raise exception 'source_fence_invalid';
  end if;
  begin
    source_epoch := (capture_source->>'epoch')::bigint;
  exception when others then
    raise exception 'source_fence_invalid';
  end;
  if source_epoch > 9007199254740991 then raise exception 'source_fence_invalid'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v105_capture_source_fence:capture', 0)
  );

  select source.* into current_fence
  from public.v105_capture_source_fence as source
  where source.scope = 'capture'
  for update;

  if found then
    if source_epoch < current_fence.epoch then
      raise exception 'stale_source_epoch';
    end if;
    if source_epoch = current_fence.epoch
       and (source_mode is distinct from current_fence.mode
         or source_owner_id is distinct from current_fence.owner_id
         or source_fence is distinct from current_fence.fence) then
      raise exception 'source_epoch_fence_conflict';
    end if;
    if source_epoch > current_fence.epoch then
      update public.v105_capture_source_fence
      set mode = source_mode, owner_id = source_owner_id, epoch = source_epoch,
          fence = source_fence, updated_at = pg_catalog.now()
      where scope = 'capture';
    end if;
  else
    insert into public.v105_capture_source_fence (scope, mode, owner_id, epoch, fence)
    values ('capture', source_mode, source_owner_id, source_epoch, source_fence);
  end if;

  -- This call shares the caller's transaction. Any envelope error rolls back
  -- the fence insert/update above without duplicating the existing Outbox logic.
  acknowledgement := public.persist_v105_capture_envelope(p_capture);
  return acknowledgement || pg_catalog.jsonb_build_object('source', capture_source);
end;
$$;

revoke all on table public.v105_capture_source_fence from public, anon, authenticated, service_role;
grant select on table public.v105_capture_source_fence to service_role;

revoke all on function public.persist_v105_fenced_capture_envelope(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.persist_v105_fenced_capture_envelope(jsonb) to service_role;

commit;
