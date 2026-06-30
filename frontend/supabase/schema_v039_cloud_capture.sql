-- v039 cloud capture data layer for AI百家
-- Apply in Supabase SQL editor with service/admin privileges.

create extension if not exists pgcrypto;

create table if not exists public.cloud_capture_sessions (
  id uuid primary key default gen_random_uuid(),
  session_key text unique,
  capture_source text not null default 'cloud_browser',
  deploy_mode text not null default 'cloud',
  status text not null default 'created',
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.cloud_capture_status (
  id uuid primary key default gen_random_uuid(),
  session_id text unique,
  capture_source text not null default 'offline',
  deploy_mode text,
  connected boolean not null default false,
  authenticated boolean not null default false,
  table_count integer not null default 0,
  last_message_at timestamptz,
  last_round_at timestamptz,
  status_text text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_table_snapshots (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  capture_source text not null default 'offline',
  table_count integer not null default 0,
  tables jsonb not null default '[]'::jsonb,
  table_summary jsonb not null default '[]'::jsonb,
  snapshot_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.cloud_table_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  source text not null default 'ofalive99',
  table_id text not null,
  table_name text,
  shoe_no text,
  round_no integer not null default 0,
  main_result text,
  banker_points integer,
  player_points integer,
  raw_event jsonb not null default '{}'::jsonb,
  table_snapshot jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(source, table_id, shoe_no, round_no)
);

create table if not exists public.cloud_strategy_reports (
  id uuid primary key default gen_random_uuid(),
  strategy_version text,
  report_type text not null default 'cloud_live_test',
  rounds integer not null default 0,
  hits integer not null default 0,
  misses integer not null default 0,
  pushes integer not null default 0,
  main_evaluated integer not null default 0,
  main_hit_rate numeric,
  report_path text,
  raw_summary jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.cloud_strategy_adjustment_stats (
  id uuid primary key default gen_random_uuid(),
  report_id text,
  strategy_mode text not null,
  evaluated integer not null default 0,
  hits integer not null default 0,
  misses integer not null default 0,
  hit_rate numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_cloud_capture_status_updated_at on public.cloud_capture_status(updated_at desc);
create index if not exists idx_cloud_table_snapshots_snapshot_at on public.cloud_table_snapshots(snapshot_at desc);
create index if not exists idx_cloud_table_rounds_table_time on public.cloud_table_rounds(table_id, received_at desc);
create index if not exists idx_cloud_strategy_reports_created_at on public.cloud_strategy_reports(created_at desc);

alter table public.cloud_capture_sessions enable row level security;
alter table public.cloud_capture_status enable row level security;
alter table public.cloud_table_snapshots enable row level security;
alter table public.cloud_table_rounds enable row level security;
alter table public.cloud_strategy_reports enable row level security;
alter table public.cloud_strategy_adjustment_stats enable row level security;

-- Read policies: frontend/member dashboards may read cloud status and latest data through anon/authenticated roles.
create policy "anon can read cloud_capture_status" on public.cloud_capture_status for select to anon, authenticated using (true);
create policy "anon can read cloud_table_snapshots" on public.cloud_table_snapshots for select to anon, authenticated using (true);
create policy "anon can read cloud_strategy_reports" on public.cloud_strategy_reports for select to anon, authenticated using (true);
create policy "anon can read cloud_strategy_adjustment_stats" on public.cloud_strategy_adjustment_stats for select to anon, authenticated using (true);

-- Write policies: only backend service role can manage cloud capture ingestion and reports.
create policy "service role can manage cloud_capture_sessions" on public.cloud_capture_sessions for all to service_role using (true) with check (true);
create policy "service role can manage cloud_capture_status" on public.cloud_capture_status for all to service_role using (true) with check (true);
create policy "service role can manage cloud_table_snapshots" on public.cloud_table_snapshots for all to service_role using (true) with check (true);
create policy "service role can manage cloud_table_rounds" on public.cloud_table_rounds for all to service_role using (true) with check (true);
create policy "service role can manage cloud_strategy_reports" on public.cloud_strategy_reports for all to service_role using (true) with check (true);
create policy "service role can manage cloud_strategy_adjustment_stats" on public.cloud_strategy_adjustment_stats for all to service_role using (true) with check (true);
