-- Formal.16 durable rollback-terminalization receipt.
-- Additive and idempotent; records the quiet-period and evidence counts that a
-- later rollback transaction must read back before restoring v105.
begin;

create table if not exists public.v106_rollback_terminalization_receipts (
  receipt_id uuid primary key default gen_random_uuid(),
  reason text not null check (reason = 'formal_v106_rollback_after_producer_stop'),
  started_at timestamptz not null,
  quiet_before timestamptz not null,
  completed_at timestamptz not null,
  max_v106_issued_at timestamptz,
  terminalized_issuance_count integer not null check (terminalized_issuance_count >= 0),
  isolated_outbox_count integer not null check (isolated_outbox_count >= 0),
  unresolved_after_count integer not null check (unresolved_after_count = 0),
  active_outbox_after_count integer not null check (active_outbox_after_count = 0),
  created_at timestamptz not null default now(),
  check (quiet_before = started_at - interval '15 seconds'),
  check (completed_at >= started_at),
  check (max_v106_issued_at is null or max_v106_issued_at <= quiet_before)
);

create index if not exists v106_rollback_terminalization_receipts_completed_idx
  on public.v106_rollback_terminalization_receipts (completed_at desc);

alter table public.v106_rollback_terminalization_receipts enable row level security;
revoke all on table public.v106_rollback_terminalization_receipts from public, anon, authenticated, service_role;
grant select on table public.v106_rollback_terminalization_receipts to service_role;

commit;
