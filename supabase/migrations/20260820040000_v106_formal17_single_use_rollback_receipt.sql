-- Formal.17 binds each rollback receipt to one v106 activation generation and
-- makes the receipt single-use so a prior cutover cannot be replayed.
begin;

alter table public.v106_rollback_terminalization_receipts
  add column if not exists cutover_generation uuid,
  add column if not exists strategy_activated_at timestamptz,
  add column if not exists consumed_at timestamptz,
  add column if not exists consumed_by text;

update public.v106_rollback_terminalization_receipts as receipt
set cutover_generation = coalesce(receipt.cutover_generation, gen_random_uuid()),
    strategy_activated_at = coalesce(
      receipt.strategy_activated_at,
      (select activated_at from public.ai_strategy_versions where version = 'v106'),
      receipt.started_at
    )
where receipt.cutover_generation is null or receipt.strategy_activated_at is null;

alter table public.v106_rollback_terminalization_receipts
  alter column cutover_generation set default gen_random_uuid(),
  alter column cutover_generation set not null,
  alter column strategy_activated_at set not null;

create unique index if not exists v106_rollback_terminalization_receipts_generation_idx
  on public.v106_rollback_terminalization_receipts (cutover_generation);

alter table public.v106_rollback_terminalization_receipts
  drop constraint if exists v106_rollback_terminalization_receipts_consumed_pair_check;
alter table public.v106_rollback_terminalization_receipts
  add constraint v106_rollback_terminalization_receipts_consumed_pair_check
  check ((consumed_at is null) = (consumed_by is null));

revoke all on table public.v106_rollback_terminalization_receipts from public, anon, authenticated, service_role;
grant select on table public.v106_rollback_terminalization_receipts to service_role;

commit;
