begin;

create or replace function public.claim_v105_capture_settlement_outbox(p_limit integer default 10)
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
  with target_session as (
    select head.session_id
    from public.v105_capture_settlement_outbox as head
    where head.attempts < 5
      and (
        head.status = 'pending'
        or (head.status = 'error' and head.next_attempt_at <= pg_catalog.now())
        or (head.status = 'processing' and head.locked_at < pg_catalog.now() - interval '5 minutes')
      )
      and not exists (
        select 1 from public.v105_capture_settlement_outbox as earlier
        where earlier.session_id = head.session_id
          and earlier.sequence < head.sequence
          and earlier.status not in ('completed','dead_letter')
      )
    order by head.created_at, head.id
    for update skip locked
    limit 1
  ), candidates as (
    select candidate.id
    from public.v105_capture_settlement_outbox as candidate
    join target_session on target_session.session_id = candidate.session_id
    where candidate.attempts < 5
      and (
        candidate.status = 'pending'
        or (candidate.status = 'error' and candidate.next_attempt_at <= pg_catalog.now())
        or (candidate.status = 'processing' and candidate.locked_at < pg_catalog.now() - interval '5 minutes')
      )
      and not exists (
        select 1 from public.v105_capture_settlement_outbox as blocker
        where blocker.session_id = candidate.session_id
          and blocker.sequence < candidate.sequence
          and blocker.status not in ('completed','dead_letter')
          and not (
            blocker.attempts < 5 and (
              blocker.status = 'pending'
              or (blocker.status = 'error' and blocker.next_attempt_at <= pg_catalog.now())
              or (blocker.status = 'processing' and blocker.locked_at < pg_catalog.now() - interval '5 minutes')
            )
          )
      )
    order by candidate.sequence, candidate.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
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
declare expected integer; matched integer; affected integer;
begin
  if pg_catalog.jsonb_typeof(p_claims) <> 'array' or pg_catalog.jsonb_array_length(p_claims) < 1 then
    raise exception 'capture outbox batch completion claims invalid';
  end if;
  select count(*) into expected from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer);
  select count(*) into matched
  from public.v105_capture_settlement_outbox as outbox
  join pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
    on outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
   and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt
  where outbox.status = 'processing';
  if matched <> expected then raise exception 'capture outbox stale batch completion rejected'; end if;
  update public.v105_capture_settlement_outbox as outbox
  set status = 'completed', processed_at = pg_catalog.now(), locked_at = null,
      next_attempt_at = null, claim_token = null, last_error = null, updated_at = pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
  where outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
    and outbox.status = 'processing' and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'capture outbox atomic batch completion rejected'; end if;
  return pg_catalog.jsonb_build_object('completed', true, 'count', affected);
end;
$$;

create or replace function public.fail_v105_capture_settlement_outbox_batch(p_claims jsonb, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare expected integer; matched integer; affected integer; isolated_count integer;
begin
  if pg_catalog.jsonb_typeof(p_claims) <> 'array' or pg_catalog.jsonb_array_length(p_claims) < 1 then
    raise exception 'capture outbox batch failure claims invalid';
  end if;
  select count(*) into expected from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer);
  select count(*) into matched
  from public.v105_capture_settlement_outbox as outbox
  join pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
    on outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
   and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt
  where outbox.status = 'processing';
  if matched <> expected then raise exception 'capture outbox stale batch failure rejected'; end if;
  update public.v105_capture_settlement_outbox as outbox
  set status = case when claim.attempt >= 5 then 'dead_letter' else 'error' end,
      isolated_at = case when claim.attempt >= 5 then pg_catalog.now() else null end,
      next_attempt_at = case when claim.attempt >= 5 then null else pg_catalog.now() + pg_catalog.make_interval(secs => least(300, (2 ^ least(claim.attempt, 8))::integer)) end,
      locked_at = null, claim_token = null,
      last_error = pg_catalog.left(coalesce(p_error, 'unknown error'), 500), updated_at = pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer)
  where outbox.session_id = claim.session_id and outbox.sequence = claim.sequence
    and outbox.status = 'processing' and outbox.claim_token = claim.claim_token and outbox.attempts = claim.attempt;
  get diagnostics affected = row_count;
  if affected <> expected then raise exception 'capture outbox atomic batch failure rejected'; end if;
  select count(*) into isolated_count from pg_catalog.jsonb_to_recordset(p_claims)
    as claim(session_id text, sequence bigint, claim_token uuid, attempt integer) where claim.attempt >= 5;
  return pg_catalog.jsonb_build_object('failed', true, 'count', affected, 'isolated_count', isolated_count);
end;
$$;

revoke all on function public.complete_v105_capture_settlement_outbox_batch(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fail_v105_capture_settlement_outbox_batch(jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.complete_v105_capture_settlement_outbox_batch(jsonb) to service_role;
grant execute on function public.fail_v105_capture_settlement_outbox_batch(jsonb,text) to service_role;

commit;
