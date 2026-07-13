-- v098: bound cloud snapshot write frequency and retain only the latest 24 hours.
-- Apply with service/admin privileges after schema_v039_cloud_capture.sql.

create or replace function public.limit_cloud_table_snapshot_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(new.session_id, '')));
  if exists (
    select 1
    from public.cloud_table_snapshots
    where session_id is not distinct from new.session_id
      and snapshot_at > now() - interval '5 seconds'
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_limit_cloud_table_snapshot_writes on public.cloud_table_snapshots;
create trigger trg_limit_cloud_table_snapshot_writes
before insert on public.cloud_table_snapshots
for each row execute function public.limit_cloud_table_snapshot_writes();

create or replace function public.cleanup_cloud_table_snapshots()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.cloud_table_snapshots
  where snapshot_at < now() - interval '24 hours';
  return null;
end;
$$;

drop trigger if exists trg_cleanup_cloud_table_snapshots on public.cloud_table_snapshots;
create trigger trg_cleanup_cloud_table_snapshots
after insert on public.cloud_table_snapshots
for each statement execute function public.cleanup_cloud_table_snapshots();

create index if not exists idx_cloud_table_snapshots_session_snapshot_at
  on public.cloud_table_snapshots(session_id, snapshot_at desc);

-- v098: v097 is the sole production strategy. Legacy rows remain as archived history.
update public.ai_strategy_versions
set status = 'archived'
where status = 'active'
  and version <> 'v097_副預測命中校準與門檻降5版';

create unique index if not exists uq_ai_strategy_versions_one_active
  on public.ai_strategy_versions(status)
  where (status = 'active');
