-- v046 formal cloud data integration (no MT auto-login, reports excluded)
-- Apply in Supabase SQL editor with service/admin privileges.

create extension if not exists pgcrypto;

create table if not exists public.manager_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  username_key text not null unique,
  password_salt text,
  password_hash text,
  role text not null default 'manager',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  role text not null default 'agent',
  parent_code text references public.agents(code) on update cascade on delete set null,
  permission text not null default '可建碼',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  duration_days integer not null default 30 check (duration_days between 1 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  account text not null unique,
  agent_id uuid references public.agents(id) on delete set null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  member_account text references public.members(account) on update cascade on delete set null,
  agent_id uuid not null references public.agents(id),
  plan_id uuid references public.plans(id),
  starts_on date not null default current_date,
  expires_on date not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.license_validation_logs (
  id uuid primary key default gen_random_uuid(),
  license_id uuid references public.licenses(id) on delete set null,
  member_account text,
  submitted_code text,
  result text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_operation_logs (
  id uuid primary key default gen_random_uuid(),
  admin_account text,
  action text not null,
  target_type text,
  target_code text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.agents add column if not exists role text not null default 'agent';
alter table public.agents add column if not exists parent_code text references public.agents(code) on update cascade on delete set null;
alter table public.agents add column if not exists permission text not null default '可建碼';
alter table public.agents add column if not exists is_active boolean not null default true;
alter table public.licenses add column if not exists member_account text references public.members(account) on update cascade on delete set null;

create index if not exists idx_agents_parent_code on public.agents(parent_code);
create index if not exists idx_agents_active_created on public.agents(is_active, created_at desc);
create index if not exists idx_members_agent_id on public.members(agent_id);
create index if not exists idx_licenses_member_account on public.licenses(member_account);
create index if not exists idx_licenses_agent_status on public.licenses(agent_id, status);
create index if not exists idx_admin_operation_logs_created_at on public.admin_operation_logs(created_at desc);

alter table public.manager_accounts enable row level security;
alter table public.agents enable row level security;
alter table public.plans enable row level security;
alter table public.members enable row level security;
alter table public.licenses enable row level security;
alter table public.license_validation_logs enable row level security;
alter table public.admin_operation_logs enable row level security;

create policy "service role manages manager_accounts" on public.manager_accounts for all to service_role using (true) with check (true);
create policy "service role manages agents" on public.agents for all to service_role using (true) with check (true);
create policy "service role manages plans" on public.plans for all to service_role using (true) with check (true);
create policy "service role manages members" on public.members for all to service_role using (true) with check (true);
create policy "service role manages licenses" on public.licenses for all to service_role using (true) with check (true);
create policy "service role manages license_validation_logs" on public.license_validation_logs for all to service_role using (true) with check (true);
create policy "service role manages admin_operation_logs" on public.admin_operation_logs for all to service_role using (true) with check (true);

-- Minimal safe reads for public frontend status; all writes stay backend/service_role only.
create policy "anon can read active plans" on public.plans for select to anon, authenticated using (true);
