-- 瑞文 AI 百家 v094 穩定性強化
-- 用途：補齊事件分層、migration 版本記錄與常用查詢索引；所有 DDL 皆採 idempotent 寫法。
-- 安全：只建立/補齊欄位與索引，不刪資料、不重建既有表；請在 Supabase SQL Editor 或受控後端環境執行。

begin;

create table if not exists public.schema_migration_versions (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.cloud_operational_events (
  id bigserial primary key,
  event_layer text not null check (event_layer in ('capture_error', 'write_error', 'monitor_error', 'control_error')),
  severity text not null default 'info' check (severity in ('info', 'warn', 'error')),
  component text,
  event_kind text,
  status_code integer,
  message text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.cloud_capture_status
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.cloud_table_snapshots
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists cloud_operational_events_layer_time_idx
  on public.cloud_operational_events (event_layer, occurred_at desc);

create index if not exists cloud_operational_events_component_time_idx
  on public.cloud_operational_events (component, occurred_at desc);

create index if not exists cloud_capture_status_updated_idx
  on public.cloud_capture_status (updated_at desc);

create index if not exists cloud_table_snapshots_snapshot_idx
  on public.cloud_table_snapshots (snapshot_at desc)
  where table_count > 0;

alter table public.schema_migration_versions enable row level security;
alter table public.cloud_operational_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'schema_migration_versions' and policyname = 'service role can manage schema migration versions'
  ) then
    create policy "service role can manage schema migration versions"
      on public.schema_migration_versions for all to service_role using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'cloud_operational_events' and policyname = 'service role can manage cloud operational events'
  ) then
    create policy "service role can manage cloud operational events"
      on public.cloud_operational_events for all to service_role using (true) with check (true);
  end if;
end $$;

comment on table public.cloud_operational_events is
  'v094 capture/write/monitor/control 分層事件紀錄；不得存放 token/service key/raw secret。';

comment on column public.cloud_operational_events.event_layer is
  '事件分層：capture_error、write_error、monitor_error、control_error。';

insert into public.schema_migration_versions (version, description, metadata)
values (
  'v094-stability',
  '備份還原演練、idempotent migration、部署回滾檢查、固定依賴、事件分層與故障測試',
  jsonb_build_object('safe', true, 'destructive', false)
)
on conflict (version) do update set
  description = excluded.description,
  metadata = excluded.metadata;

commit;
