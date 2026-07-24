begin;

alter table public.memory_test_reports
  add column if not exists report_date date,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists memory_test_reports_project_strategy_type_date_key
  on public.memory_test_reports(project_id, strategy_version, report_type, report_date);

commit;
