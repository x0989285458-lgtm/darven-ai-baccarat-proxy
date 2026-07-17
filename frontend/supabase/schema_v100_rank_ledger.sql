-- v100 formal release: immutable verified-Final card events and a durable eight-deck
-- observation-only rank ledger. Additive and NOT auto-executed.
-- The database derives hashes, rank deltas and ledger counts from exact10; callers
-- cannot supply authoritative counts. Apply only after dry-run and explicit approval.

begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shoe_round_card_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  table_id text not null,
  shoe_no text not null,
  round_no integer not null check (round_no >= 1),
  raw_result_exact10 jsonb not null,
  dealt_rank_delta jsonb not null,
  source_action text not null,
  event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
  applied boolean not null default false,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint shoe_round_card_events_identity unique (source, table_id, shoe_no, round_no),
  constraint shoe_round_card_events_exact10 check (
    jsonb_typeof(raw_result_exact10) = 'array'
    and jsonb_array_length(raw_result_exact10) = 10
  ),
  constraint shoe_round_card_events_delta_object check (jsonb_typeof(dealt_rank_delta) = 'object')
);

create table if not exists public.shoe_rank_ledgers (
  source text not null,
  table_id text not null,
  shoe_no text not null,
  deck_count integer not null default 8 check (deck_count = 8),
  complete_through_round integer not null default 0 check (complete_through_round >= 0),
  seen_dealt_rank_counts jsonb not null,
  seen_dealt_code_counts jsonb not null,
  undealt_after_observed_deals jsonb not null,
  cards_seen_dealt integer not null default 0 check (cards_seen_dealt between 0 and 416),
  physical_remaining_exact boolean not null default false check (physical_remaining_exact = false),
  burn_observation_status text not null default 'unavailable' check (burn_observation_status = 'unavailable'),
  status text not null default 'waiting_round1' check (status in ('waiting_round1', 'contiguous', 'gap', 'conflicted', 'invalid')),
  ledger_checksum text not null check (ledger_checksum ~ '^[0-9a-f]{64}$'),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, table_id, shoe_no),
  constraint shoe_rank_ledgers_seen_object check (jsonb_typeof(seen_dealt_rank_counts) = 'object'),
  constraint shoe_rank_ledgers_code_object check (jsonb_typeof(seen_dealt_code_counts) = 'object'),
  constraint shoe_rank_ledgers_undealt_object check (jsonb_typeof(undealt_after_observed_deals) = 'object')
);

create index if not exists idx_shoe_round_card_events_received
  on public.shoe_round_card_events(received_at desc);
create index if not exists idx_shoe_rank_ledgers_updated
  on public.shoe_rank_ledgers(updated_at desc);

alter table public.shoe_round_card_events enable row level security;
alter table public.shoe_rank_ledgers enable row level security;
revoke all on table public.shoe_round_card_events from public, anon, authenticated, service_role;
revoke all on table public.shoe_rank_ledgers from public, anon, authenticated, service_role;
grant select on table public.shoe_round_card_events to service_role;
grant select on table public.shoe_rank_ledgers to service_role;

create or replace function public.reject_v100_rank_event_evidence_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'v100 rank event evidence is immutable';
  end if;
  if new.source is distinct from old.source
     or new.table_id is distinct from old.table_id
     or new.shoe_no is distinct from old.shoe_no
     or new.round_no is distinct from old.round_no
     or new.raw_result_exact10 is distinct from old.raw_result_exact10
     or new.dealt_rank_delta is distinct from old.dealt_rank_delta
     or new.source_action is distinct from old.source_action
     or new.event_hash is distinct from old.event_hash
     or new.received_at is distinct from old.received_at
     or new.created_at is distinct from old.created_at then
    raise exception 'v100 rank event evidence is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reject_v100_rank_event_evidence_mutation on public.shoe_round_card_events;
create trigger trg_reject_v100_rank_event_evidence_mutation
before update or delete on public.shoe_round_card_events
for each row execute function public.reject_v100_rank_event_evidence_mutation();

create or replace function public.apply_v100_rank_ledger_event(p_event jsonb, p_ledger jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_source text := nullif(p_event->>'source', '');
  v_table text := nullif(p_event->>'table_id', '');
  v_shoe text := nullif(p_event->>'shoe_no', '');
  v_round integer;
  v_action text := nullif(p_event->>'source_action', '');
  v_raw jsonb := p_event->'raw_result_exact10';
  v_hash text;
  v_existing_event public.shoe_round_card_events%rowtype;
  v_existing_ledger public.shoe_rank_ledgers%rowtype;
  v_expected integer;
  v_card integer;
  v_rank text;
  v_cards_seen integer;
  v_revision bigint;
  v_ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  v_zero_seen jsonb;
  v_zero_codes jsonb;
  v_new_seen jsonb;
  v_new_codes jsonb;
  v_undealt jsonb;
  v_delta jsonb := '{}'::jsonb;
  v_checksum text;
begin
  begin
    v_round := nullif(p_event->>'round_no', '')::integer;
  exception when others then
    raise exception 'invalid verified-Final rank event';
  end;

  if v_source is null or v_table is null or v_shoe is null or v_round is null or v_round < 1
     or v_action not in (
       'summary', '/summary', '/api/v1/gametype/*/game/*/room/*/table/*/summary',
       'show_win', '/show_win', '/api/v1/gametype/*/game/*/room/*/table/*/show_win'
     )
     or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) <> 10 then
    raise exception 'invalid verified-Final rank event';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_raw) with ordinality as x(value, position)
    where jsonb_typeof(value) <> 'number'
       or (value::text)::numeric <> trunc((value::text)::numeric)
       or (position between 1 and 4 and (value::text)::integer not between 1 and 52)
       or (position between 5 and 8 and (value::text)::integer not between -1 and 52)
       or (position between 9 and 10 and (value::text)::integer not between 0 and 9)
  ) then
    raise exception 'invalid exact10 card values';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v100-rank|' || v_source || '|' || v_table || '|' || v_shoe, 0)
  );

  select jsonb_object_agg(rank, 0) into v_zero_seen from unnest(v_ranks) as r(rank);
  select jsonb_object_agg(code::text, 0) into v_zero_codes from generate_series(1, 52) as c(code);
  v_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('source_action', v_action, 'raw_result_exact10', v_raw)::text, 'UTF8'
  ), 'sha256'), 'hex');
  select coalesce(jsonb_object_agg(rank, count), '{}'::jsonb)
    into v_delta
  from (
    select v_ranks[(((card.value::text)::integer - 1) % 13) + 1] as rank, count(*)::integer as count
    from jsonb_array_elements(v_raw) with ordinality as card(value, position)
    where card.position between 1 and 6 and (card.value::text)::integer between 1 and 52
    group by 1
  ) as derived_delta;

  select * into v_existing_event
  from public.shoe_round_card_events
  where source = v_source and table_id = v_table and shoe_no = v_shoe and round_no = v_round
  for update;

  if v_existing_event.id is not null and v_existing_event.event_hash is distinct from v_hash then
    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, seen_dealt_rank_counts, seen_dealt_code_counts,
      undealt_after_observed_deals, status, ledger_checksum
    ) values (
      v_source, v_table, v_shoe, v_zero_seen, v_zero_codes, v_zero_seen,
      'conflicted', repeat('0', 64)
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'conflicted', revision = shoe_rank_ledgers.revision + 1, updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'conflicted', 'reason', 'conflicting_round_identity');
  end if;

  select * into v_existing_ledger
  from public.shoe_rank_ledgers
  where source = v_source and table_id = v_table and shoe_no = v_shoe
  for update;

  if v_existing_ledger.status in ('conflicted', 'invalid') then
    return jsonb_build_object('accepted', false, 'status', v_existing_ledger.status, 'revision', v_existing_ledger.revision);
  end if;

  if v_existing_event.applied is true then
    return jsonb_build_object(
      'accepted', true, 'duplicate', true, 'status', v_existing_ledger.status,
      'complete_through_round', v_existing_ledger.complete_through_round,
      'revision', v_existing_ledger.revision,
      'seen_dealt_rank_counts', v_existing_ledger.seen_dealt_rank_counts,
      'seen_dealt_code_counts', v_existing_ledger.seen_dealt_code_counts,
      'undealt_after_observed_deals', v_existing_ledger.undealt_after_observed_deals,
      'cards_seen_dealt', v_existing_ledger.cards_seen_dealt,
      'ledger_checksum', v_existing_ledger.ledger_checksum,
      'physical_remaining_exact', v_existing_ledger.physical_remaining_exact,
      'burn_observation_status', v_existing_ledger.burn_observation_status
    );
  end if;

  v_expected := coalesce(v_existing_ledger.complete_through_round, 0) + 1;
  if v_round <> v_expected then
    insert into public.shoe_round_card_events (
      source, table_id, shoe_no, round_no, raw_result_exact10, dealt_rank_delta, source_action, event_hash, applied
    ) values (v_source, v_table, v_shoe, v_round, v_raw, v_delta, v_action, v_hash, false)
    on conflict (source, table_id, shoe_no, round_no) do nothing;

    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, seen_dealt_rank_counts, seen_dealt_code_counts,
      undealt_after_observed_deals, status, ledger_checksum
    ) values (
      v_source, v_table, v_shoe, v_zero_seen, v_zero_codes, v_zero_seen,
      'gap', repeat('0', 64)
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'gap', revision = shoe_rank_ledgers.revision + 1, updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'gap', 'expected_round', v_expected);
  end if;

  v_new_seen := coalesce(v_existing_ledger.seen_dealt_rank_counts, v_zero_seen);
  v_new_codes := coalesce(v_existing_ledger.seen_dealt_code_counts, v_zero_codes);
  v_cards_seen := coalesce(v_existing_ledger.cards_seen_dealt, 0);

  for v_card in
    select (value::text)::integer
    from jsonb_array_elements(v_raw) with ordinality as card(value, position)
    where position between 1 and 6 and (value::text)::integer between 1 and 52
  loop
    v_rank := v_ranks[((v_card - 1) % 13) + 1];
    v_new_seen := jsonb_set(v_new_seen, array[v_rank], to_jsonb(coalesce((v_new_seen->>v_rank)::integer, 0) + 1), true);
    v_new_codes := jsonb_set(v_new_codes, array[v_card::text], to_jsonb(coalesce((v_new_codes->>v_card::text)::integer, 0) + 1), true);
    v_cards_seen := v_cards_seen + 1;
  end loop;

  if v_cards_seen > 416
     or exists (select 1 from jsonb_each_text(v_new_seen) where value::integer not between 0 and 32)
     or exists (select 1 from jsonb_each_text(v_new_codes) where value::integer not between 0 and 8) then
    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, seen_dealt_rank_counts, seen_dealt_code_counts,
      undealt_after_observed_deals, cards_seen_dealt, status, ledger_checksum
    ) values (
      v_source, v_table, v_shoe, coalesce(v_existing_ledger.seen_dealt_rank_counts, v_zero_seen),
      coalesce(v_existing_ledger.seen_dealt_code_counts, v_zero_codes), v_zero_seen,
      coalesce(v_existing_ledger.cards_seen_dealt, 0), 'invalid', repeat('0', 64)
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'invalid', revision = shoe_rank_ledgers.revision + 1, updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'invalid', 'reason', 'physical_card_limit_exceeded');
  end if;

  select jsonb_object_agg(rank, 32 - coalesce((v_new_seen->>rank)::integer, 0))
    into v_undealt from unnest(v_ranks) as r(rank);
  v_checksum := encode(extensions.digest(convert_to(jsonb_build_object(
    'source', v_source, 'table_id', v_table, 'shoe_no', v_shoe,
    'complete_through_round', v_round, 'seen_dealt_rank_counts', v_new_seen,
    'seen_dealt_code_counts', v_new_codes, 'cards_seen_dealt', v_cards_seen,
    'physical_remaining_exact', false, 'burn_observation_status', 'unavailable'
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.shoe_round_card_events (
    source, table_id, shoe_no, round_no, raw_result_exact10, dealt_rank_delta, source_action, event_hash, applied
  ) values (v_source, v_table, v_shoe, v_round, v_raw, v_delta, v_action, v_hash, true)
  on conflict (source, table_id, shoe_no, round_no) do update set applied = true
  where shoe_round_card_events.event_hash = excluded.event_hash
    and shoe_round_card_events.applied = false;

  insert into public.shoe_rank_ledgers (
    source, table_id, shoe_no, complete_through_round, seen_dealt_rank_counts,
    seen_dealt_code_counts, undealt_after_observed_deals, cards_seen_dealt,
    physical_remaining_exact, burn_observation_status, status, ledger_checksum, revision
  ) values (
    v_source, v_table, v_shoe, v_round, v_new_seen, v_new_codes, v_undealt, v_cards_seen,
    false, 'unavailable', 'contiguous', v_checksum, 1
  ) on conflict (source, table_id, shoe_no) do update set
    complete_through_round = excluded.complete_through_round,
    seen_dealt_rank_counts = excluded.seen_dealt_rank_counts,
    seen_dealt_code_counts = excluded.seen_dealt_code_counts,
    undealt_after_observed_deals = excluded.undealt_after_observed_deals,
    cards_seen_dealt = excluded.cards_seen_dealt,
    status = 'contiguous', ledger_checksum = excluded.ledger_checksum,
    revision = shoe_rank_ledgers.revision + 1, updated_at = now();

  select revision into v_revision from public.shoe_rank_ledgers
  where source = v_source and table_id = v_table and shoe_no = v_shoe;
  return jsonb_build_object(
    'accepted', true, 'duplicate', false, 'status', 'contiguous',
    'complete_through_round', v_round, 'revision', v_revision,
    'seen_dealt_rank_counts', v_new_seen,
    'seen_dealt_code_counts', v_new_codes,
    'undealt_after_observed_deals', v_undealt,
    'cards_seen_dealt', v_cards_seen,
    'ledger_checksum', v_checksum,
    'physical_remaining_exact', false,
    'burn_observation_status', 'unavailable'
  );
end;
$$;

revoke all on function public.apply_v100_rank_ledger_event(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_v100_rank_ledger_event(jsonb, jsonb) to service_role;

commit;
