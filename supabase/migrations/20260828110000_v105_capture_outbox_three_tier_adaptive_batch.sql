begin;

create or replace function public.claim_v105_capture_settlement_outbox_batch(p_limit integer default 30)
returns setof public.v105_capture_settlement_outbox
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'capture outbox batch limit must be between 1 and 100';
  end if;

  update public.v105_capture_settlement_outbox as poison
  set status = 'dead_letter', isolated_at = pg_catalog.now(), locked_at = null,
      next_attempt_at = null, claim_token = null, updated_at = pg_catalog.now()
  where poison.attempts >= 5
    and ((poison.status = 'error' and poison.next_attempt_at <= pg_catalog.now())
      or (poison.status = 'processing' and poison.locked_at < pg_catalog.now() - interval '5 minutes'));

  return query
  with head as materialized (
    select candidate.id, candidate.session_id, candidate.sequence
    from public.v105_capture_settlement_outbox as candidate
    where candidate.attempts < 5
      and (
        candidate.status = 'pending'
        or (candidate.status = 'error' and candidate.next_attempt_at <= pg_catalog.now())
        or (candidate.status = 'processing' and candidate.locked_at < pg_catalog.now() - interval '5 minutes')
      )
      and not exists (
        select 1 from public.v105_capture_settlement_outbox as earlier
        where earlier.session_id = candidate.session_id
          and earlier.sequence < candidate.sequence
          and earlier.status not in ('completed', 'dead_letter')
      )
    order by candidate.created_at, candidate.id
    for update skip locked
    limit 1
  ), ordered as materialized (
    select outbox.id, outbox.sequence,
      pg_catalog.bool_or(not (
        outbox.attempts < 5
        and (
          outbox.status = 'pending'
          or (outbox.status = 'error' and outbox.next_attempt_at <= pg_catalog.now())
          or (outbox.status = 'processing' and outbox.locked_at < pg_catalog.now() - interval '5 minutes')
        )
      )) over (order by outbox.sequence rows between unbounded preceding and current row) as blocked
    from public.v105_capture_settlement_outbox as outbox
    join head on head.session_id = outbox.session_id and outbox.sequence >= head.sequence
    where outbox.status not in ('completed', 'dead_letter')
  ), batch_policy as materialized (
    select case
      when exists (
        select 1 from ordered as ready where ready.blocked is false
        order by ready.sequence offset 300 limit 1
      ) then 100
      when exists (
        select 1 from ordered as ready where ready.blocked is false
        order by ready.sequence offset 29 limit 1
      ) then 30
      else 10
    end as effective_max
  ), candidates as (
    select ordered.id
    from ordered
    where ordered.blocked is false
    order by ordered.sequence
    limit least(p_limit, (select batch_policy.effective_max from batch_policy))
  ), claimed as (
    update public.v105_capture_settlement_outbox as outbox
    set status = 'processing', attempts = outbox.attempts + 1,
        lease_generation = outbox.lease_generation + 1,
        claim_token = pg_catalog.gen_random_uuid(), locked_at = pg_catalog.now(),
        next_attempt_at = null, updated_at = pg_catalog.now(), last_error = null
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select claimed.* from claimed order by claimed.sequence, claimed.id;
end;
$$;

commit;
