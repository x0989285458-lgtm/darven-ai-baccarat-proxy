begin;

create or replace function public.claim_v105_capture_settlement_outbox_batch(p_limit integer default 10)
returns setof public.v105_capture_settlement_outbox
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
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
        select 1
        from public.v105_capture_settlement_outbox as earlier
        where earlier.session_id = candidate.session_id
          and earlier.sequence < candidate.sequence
          and earlier.status not in ('completed', 'dead_letter')
      )
    order by candidate.created_at, candidate.id
    for update skip locked
    limit 1
  ), ordered as (
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
  ), candidates as (
    select ordered.id
    from ordered
    where ordered.blocked is false
    order by ordered.sequence
    limit greatest(1, least(coalesce(p_limit, 10), 10))
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

create or replace function public.complete_v105_capture_settlement_outbox_batch(p_claims jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare expected integer; affected integer;
begin
  if pg_catalog.jsonb_typeof(p_claims) <> 'array' then
    raise exception 'capture outbox batch claims must be an array';
  end if;
  select count(*), count(distinct (item->>'session_id', (item->>'sequence')::bigint))
  into expected, affected
  from pg_catalog.jsonb_array_elements(p_claims) as claim(item);
  if expected < 1 or expected > 10 or affected <> expected then
    raise exception 'capture outbox batch claim identity is invalid';
  end if;

  with claims as (
    select item->>'session_id' as session_id,
      (item->>'sequence')::bigint as sequence,
      (item->>'claim_token')::uuid as claim_token,
      (item->>'attempt')::integer as attempt
    from pg_catalog.jsonb_array_elements(p_claims) as claim(item)
  )
  update public.v105_capture_settlement_outbox as outbox
  set status = 'completed', processed_at = pg_catalog.now(), locked_at = null,
      next_attempt_at = null, claim_token = null, last_error = null, updated_at = pg_catalog.now()
  from claims
  where outbox.session_id = claims.session_id and outbox.sequence = claims.sequence
    and outbox.status = 'processing' and outbox.claim_token = claims.claim_token
    and outbox.attempts = claims.attempt;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'capture outbox stale batch completion rejected'; end if;
  return pg_catalog.jsonb_build_object('completed', true, 'count', affected);
end;
$$;

create or replace function public.fail_v105_capture_settlement_outbox_batch(p_claims jsonb, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare expected integer; affected integer; isolated_count integer;
begin
  if pg_catalog.jsonb_typeof(p_claims) <> 'array' then
    raise exception 'capture outbox batch claims must be an array';
  end if;
  select count(*), count(distinct (item->>'session_id', (item->>'sequence')::bigint))
  into expected, affected
  from pg_catalog.jsonb_array_elements(p_claims) as claim(item);
  if expected < 1 or expected > 10 or affected <> expected then
    raise exception 'capture outbox batch claim identity is invalid';
  end if;

  with claims as (
    select item->>'session_id' as session_id,
      (item->>'sequence')::bigint as sequence,
      (item->>'claim_token')::uuid as claim_token,
      (item->>'attempt')::integer as attempt
    from pg_catalog.jsonb_array_elements(p_claims) as claim(item)
  )
  update public.v105_capture_settlement_outbox as outbox
  set status = case when claims.attempt >= 5 then 'dead_letter' else 'error' end,
      isolated_at = case when claims.attempt >= 5 then pg_catalog.now() else null end,
      next_attempt_at = case when claims.attempt >= 5 then null else pg_catalog.now() + pg_catalog.make_interval(secs => least(300, (2 ^ least(claims.attempt, 8))::integer)) end,
      locked_at = null, claim_token = null,
      last_error = pg_catalog.left(coalesce(p_error, 'unknown error'), 500),
      updated_at = pg_catalog.now()
  from claims
  where outbox.session_id = claims.session_id and outbox.sequence = claims.sequence
    and outbox.status = 'processing' and outbox.claim_token = claims.claim_token
    and outbox.attempts = claims.attempt;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'capture outbox stale batch failure rejected'; end if;
  select count(*) into isolated_count
  from pg_catalog.jsonb_array_elements(p_claims) as claim(item)
  where (item->>'attempt')::integer >= 5;
  return pg_catalog.jsonb_build_object('failed', true, 'count', affected, 'isolated_count', isolated_count);
end;
$$;

revoke all on function public.claim_v105_capture_settlement_outbox_batch(integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_v105_capture_settlement_outbox_batch(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fail_v105_capture_settlement_outbox_batch(jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.claim_v105_capture_settlement_outbox_batch(integer) to service_role;
grant execute on function public.complete_v105_capture_settlement_outbox_batch(jsonb) to service_role;
grant execute on function public.fail_v105_capture_settlement_outbox_batch(jsonb,text) to service_role;

commit;
