-- Darven AI Baccarat / AI百家預測
-- v011 Supabase schema draft
-- 目的：建立每日路單、AI預測、策略版本、管理設定基礎
-- 狀態：草稿，尚未執行。請先檢查再貼到 Supabase SQL Editor 或交由 Draven 執行。

begin;

-- 需要 UUID 產生工具
create extension if not exists pgcrypto;

-- 1) app_settings：系統設定，例如資料保留天數、目前啟用策略
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "Public can read safe app settings" on public.app_settings;
create policy "Public can read safe app settings"
  on public.app_settings
  for select
  to anon, authenticated
  using (key in ('active_strategy_version', 'frontend_status', 'retention_days'));

-- 2) admin_profiles：管理者資料，綁 Supabase Auth user id
create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'admin' check (role in ('owner', 'admin', 'viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_profiles enable row level security;

drop policy if exists "Admins can read own profile" on public.admin_profiles;
create policy "Admins can read own profile"
  on public.admin_profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- 3) baccarat_tables：桌台目前狀態 / 前台顯示資料
create table if not exists public.baccarat_tables (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ofalive99',
  table_id text not null,
  table_name text,
  display_name text,
  table_type text,
  current_shoe text,
  current_round integer,
  total_round_banker integer not null default 0,
  total_round_player integer not null default 0,
  total_round_tie integer not null default 0,
  total_round_banker_pair integer not null default 0,
  total_round_player_pair integer not null default 0,
  is_active boolean not null default true,
  raw_trend jsonb,
  updated_at timestamptz not null default now(),
  unique (source, table_id)
);

create index if not exists baccarat_tables_active_idx on public.baccarat_tables (is_active, updated_at desc);
create index if not exists baccarat_tables_source_table_idx on public.baccarat_tables (source, table_id);

alter table public.baccarat_tables enable row level security;

drop policy if exists "Public can read active baccarat tables" on public.baccarat_tables;
create policy "Public can read active baccarat tables"
  on public.baccarat_tables
  for select
  to anon, authenticated
  using (is_active = true);

-- 4) daily_roadmap_events：每日實際開牌資料，短期保存
create table if not exists public.daily_roadmap_events (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ofalive99',
  table_id text not null,
  shoe_no text,
  round_no integer not null,
  main_result text not null check (main_result in ('banker', 'player', 'tie')),
  banker_points integer check (banker_points between 0 and 9),
  player_points integer check (player_points between 0 and 9),
  point_diff integer generated always as (abs(coalesce(banker_points, 0) - coalesce(player_points, 0))) stored,
  is_tie boolean generated always as (main_result = 'tie') stored,
  banker_pair boolean not null default false,
  player_pair boolean not null default false,
  super_six boolean not null default false,
  bead_code text,
  raw_event jsonb,
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source, table_id, shoe_no, round_no)
);

create index if not exists daily_roadmap_events_opened_idx on public.daily_roadmap_events (opened_at desc);
create index if not exists daily_roadmap_events_table_round_idx on public.daily_roadmap_events (source, table_id, shoe_no, round_no);
create index if not exists daily_roadmap_events_result_idx on public.daily_roadmap_events (main_result, opened_at desc);

alter table public.daily_roadmap_events enable row level security;

drop policy if exists "Public can read recent roadmap events" on public.daily_roadmap_events;
create policy "Public can read recent roadmap events"
  on public.daily_roadmap_events
  for select
  to anon, authenticated
  using (opened_at >= now() - interval '1 day');

-- 5) daily_prediction_results：每日 AI 預測結果，短期保存
create table if not exists public.daily_prediction_results (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ofalive99',
  table_id text not null,
  shoe_no text,
  round_no integer not null,
  strategy_version text,
  predicted_result text not null check (predicted_result in ('banker', 'player', 'tie', 'observe')),
  confidence integer not null check (confidence between 0 and 100),
  actual_result text check (actual_result in ('banker', 'player', 'tie')),
  is_hit boolean,
  prediction_features jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (source, table_id, shoe_no, round_no, strategy_version)
);

create index if not exists daily_prediction_results_created_idx on public.daily_prediction_results (created_at desc);
create index if not exists daily_prediction_results_strategy_idx on public.daily_prediction_results (strategy_version, created_at desc);
create index if not exists daily_prediction_results_hit_idx on public.daily_prediction_results (is_hit, created_at desc);

alter table public.daily_prediction_results enable row level security;

drop policy if exists "Public can read recent prediction results" on public.daily_prediction_results;
create policy "Public can read recent prediction results"
  on public.daily_prediction_results
  for select
  to anon, authenticated
  using (created_at >= now() - interval '1 day');

-- 6) ai_strategy_versions：長期保存的每日策略權重/版本
create table if not exists public.ai_strategy_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived', 'rollback')),
  learned_from_date date,
  sample_count integer not null default 0,
  total_hit_rate numeric(6,4),
  high_confidence_hit_rate numeric(6,4),
  weights jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create index if not exists ai_strategy_versions_status_idx on public.ai_strategy_versions (status, created_at desc);

alter table public.ai_strategy_versions enable row level security;

drop policy if exists "Public can read active strategy" on public.ai_strategy_versions;
create policy "Public can read active strategy"
  on public.ai_strategy_versions
  for select
  to anon, authenticated
  using (status = 'active');

-- 7) model_versions：每月/偶爾大模型訓練或微調版本 metadata
create table if not exists public.model_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  provider text,
  model_name text,
  training_period daterange,
  dataset_summary jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  artifact_url text,
  status text not null default 'planned' check (status in ('planned', 'training', 'active', 'archived', 'failed')),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

alter table public.model_versions enable row level security;

drop policy if exists "Authenticated can read model versions" on public.model_versions;
create policy "Authenticated can read model versions"
  on public.model_versions
  for select
  to authenticated
  using (true);

-- 8) updated_at trigger function
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

drop trigger if exists set_admin_profiles_updated_at on public.admin_profiles;
create trigger set_admin_profiles_updated_at
before update on public.admin_profiles
for each row execute function public.set_updated_at();

-- 9) 短期資料清理函式：預設刪除 1 天前的詳細路單與預測明細
create or replace function public.cleanup_short_retention_data(retention interval default interval '1 day')
returns table(deleted_roadmap bigint, deleted_predictions bigint)
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.cleanup_short_retention_data(interval) from public;

-- 10) 初始設定
insert into public.app_settings (key, value, description)
values
  ('retention_days', '1'::jsonb, '短期路單與預測明細保留天數'),
  ('frontend_status', '{"enabled":true,"message":"AI百家預測運行中"}'::jsonb, '前台顯示狀態')
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now();

commit;

-- 選用：若 Supabase 專案支援 pg_cron，可在確認後另行執行以下排程。
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'cleanup-ai-baccarat-short-retention',
--   '10 4 * * *',
--   $$select * from public.cleanup_short_retention_data(interval '1 day');$$
-- );
