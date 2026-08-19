-- V106 formal.8: preserve the earliest trusted Final receive time across every writer path.
-- This migration is additive and rerunnable. It does not mutate existing round identities.

create or replace function public.preserve_cloud_round_first_received_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.received_at := least(old.received_at, new.received_at);
  return new;
end;
$$;

revoke all on function public.preserve_cloud_round_first_received_at() from public;

-- Trigger replacement is metadata-only and keeps the migration idempotent.
drop trigger if exists preserve_cloud_round_first_received_at on public.cloud_table_rounds;
create trigger preserve_cloud_round_first_received_at
before update of received_at on public.cloud_table_rounds
for each row execute function public.preserve_cloud_round_first_received_at();
