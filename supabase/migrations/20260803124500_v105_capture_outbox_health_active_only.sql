create index concurrently if not exists v105_capture_settlement_outbox_health_idx
  on public.v105_capture_settlement_outbox
  (status, created_at, attempts, session_id, sequence, next_attempt_at, locked_at)
  where status <> 'completed';

create or replace function public.get_v105_capture_outbox_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with operational as materialized (
    select
      outbox.status,
      outbox.created_at,
      outbox.next_attempt_at,
      outbox.locked_at,
      outbox.attempts,
      outbox.session_id,
      outbox.sequence,
      not exists (
        select 1
        from public.v105_capture_settlement_outbox as earlier
        where earlier.session_id = outbox.session_id
          and earlier.sequence < outbox.sequence
          and earlier.status not in ('completed', 'dead_letter')
      ) as is_session_head
    from public.v105_capture_settlement_outbox as outbox
    where outbox.status <> 'completed'
  )
  select pg_catalog.jsonb_build_object(
    'pending', pg_catalog.count(*) filter (where outbox.status = 'pending'),
    'processing', pg_catalog.count(*) filter (where outbox.status = 'processing'),
    'error', pg_catalog.count(*) filter (where outbox.status = 'error'),
    'dead_letter', pg_catalog.count(*) filter (where outbox.status = 'dead_letter'),
    'oldest_unfinished_at', pg_catalog.min(outbox.created_at) filter (where outbox.status not in ('completed', 'dead_letter')),
    'next_wakeup_at', pg_catalog.min(case
      when outbox.is_session_head and outbox.status = 'pending' then pg_catalog.now()
      when outbox.is_session_head and outbox.status = 'error' then outbox.next_attempt_at
      when outbox.is_session_head and outbox.status = 'processing' then outbox.locked_at + interval '5 minutes'
      else null
    end),
    'max_attempts', pg_catalog.max(outbox.attempts),
    'alert', (pg_catalog.count(*) filter (where outbox.status = 'dead_letter')) > 0
  )
  from operational as outbox;
$$;

revoke all on function public.get_v105_capture_outbox_health() from public, anon, authenticated, service_role;
grant execute on function public.get_v105_capture_outbox_health() to service_role;
