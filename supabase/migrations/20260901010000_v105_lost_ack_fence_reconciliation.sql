begin;

create or replace function public.reconcile_v105_capture_envelope(p_capture jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  capture_session text := nullif(p_capture->>'session_id', '');
  capture_sequence bigint;
  capture_round_keys jsonb := coalesce(p_capture->'round_keys', '[]'::jsonb);
  canonical_payload_hash text;
  existing_payload_hash text;
  existing_payload jsonb;
  existing_round_keys jsonb;
begin
  if capture_session is null then raise exception 'capture session_id is required'; end if;
  begin
    capture_sequence := (p_capture->>'sequence')::bigint;
  exception when others then
    raise exception 'capture sequence is required';
  end;
  if capture_sequence < 1 then raise exception 'capture sequence must be positive'; end if;
  if pg_catalog.jsonb_typeof(capture_round_keys) <> 'array' then
    raise exception 'capture round_keys must be an array';
  end if;

  canonical_payload_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_capture::text, 'UTF8'), 'sha256'),
    'hex'
  );

  -- Serialize with persist_v105_capture_envelope for the same immutable session.
  -- Once this lock is acquired, an older in-flight persist has either committed
  -- and is visible below, or rolled back and exact not-found is authoritative.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(capture_session, 0));

  select outbox.payload_hash, outbox.payload, outbox.round_keys
    into existing_payload_hash, existing_payload, existing_round_keys
  from public.v105_capture_settlement_outbox as outbox
  where outbox.session_id = capture_session and outbox.sequence = capture_sequence
  for share;

  if not found then raise exception 'capture_reconciliation_not_found'; end if;
  if existing_payload_hash is distinct from canonical_payload_hash
     or existing_payload is distinct from p_capture
     or existing_round_keys is distinct from capture_round_keys then
    raise exception 'capture identity conflict';
  end if;

  return pg_catalog.jsonb_build_object(
    'persisted', true, 'duplicate', true, 'session_id', capture_session,
    'sequence', capture_sequence, 'accepted_round_keys', existing_round_keys,
    'payload_hash', existing_payload_hash
  );
end;
$$;

revoke all on function public.reconcile_v105_capture_envelope(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_v105_capture_envelope(jsonb) to service_role;

commit;
