-- v100 candidate: immutable verified-Final card events and durable eight-deck rank ledger.
-- Additive only. This file is NOT auto-executed and must not be applied before the
-- application candidate, dry-run validation, and explicit production approval.

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
  undealt_after_observed_deals jsonb not null,
  cards_seen_dealt integer not null default 0 check (cards_seen_dealt between 0 and 416),
  burn_count integer,
  burn_rank_counts jsonb,
  physical_remaining_exact boolean not null default false check (physical_remaining_exact = false),
  burn_observation_status text not null default 'unavailable' check (burn_observation_status in ('unavailable', 'count_only', 'exact')),
  status text not null default 'waiting_round1' check (status in ('waiting_round1', 'contiguous', 'gap', 'conflicted', 'invalid', 'closed')),
  ledger_checksum text not null check (ledger_checksum ~ '^[0-9a-f]{64}$'),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, table_id, shoe_no),
  constraint shoe_rank_ledgers_seen_object check (jsonb_typeof(seen_dealt_rank_counts) = 'object'),
  constraint shoe_rank_ledgers_undealt_object check (jsonb_typeof(undealt_after_observed_deals) = 'object'),
  constraint shoe_rank_ledgers_burn_consistency check (
    (burn_observation_status = 'unavailable' and burn_count is null and burn_rank_counts is null)
    or (burn_observation_status = 'count_only' and burn_count is not null and burn_rank_counts is null)
    or (burn_observation_status = 'exact' and burn_count is not null and jsonb_typeof(burn_rank_counts) = 'object')
  )
);

create index if not exists idx_shoe_round_card_events_received
  on public.shoe_round_card_events(received_at desc);
create index if not exists idx_shoe_rank_ledgers_updated
  on public.shoe_rank_ledgers(updated_at desc);

alter table public.shoe_round_card_events enable row level security;
alter table public.shoe_rank_ledgers enable row level security;
revoke all on table public.shoe_round_card_events from public, anon, authenticated;
revoke all on table public.shoe_rank_ledgers from public, anon, authenticated;
grant select, insert, update on table public.shoe_round_card_events to service_role;
grant select, insert, update on table public.shoe_rank_ledgers to service_role;

create or replace function public.apply_v100_rank_ledger_event(p_event jsonb, p_ledger jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text := nullif(p_event->>'source', '');
  v_table text := nullif(p_event->>'table_id', '');
  v_shoe text := nullif(p_event->>'shoe_no', '');
  v_round integer := nullif(p_event->>'round_no', '')::integer;
  v_action text := nullif(p_event->>'source_action', '');
  v_hash text := nullif(p_event->>'event_hash', '');
  v_existing_event public.shoe_round_card_events%rowtype;
  v_existing_ledger public.shoe_rank_ledgers%rowtype;
  v_expected integer;
  v_cards_seen integer;
  v_bad_count boolean;
begin
  if v_source is null or v_table is null or v_shoe is null or v_round is null or v_round < 1
     or v_action is null or (v_action not like '%/summary' and v_action not like '%/show_win')
     or v_hash is null or v_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_event->'raw_result_exact10') <> 'array'
     or jsonb_array_length(p_event->'raw_result_exact10') <> 10
     or jsonb_typeof(p_event->'dealt_rank_delta') <> 'object' then
    raise exception 'invalid verified-Final rank event';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_event->'raw_result_exact10') with ordinality as x(value, position)
    where jsonb_typeof(value) <> 'number'
       or (value::text)::numeric <> trunc((value::text)::numeric)
       or (position between 1 and 6 and not ((value::text)::integer = -1 or (value::text)::integer between 1 and 52))
       or (position between 7 and 8 and (value::text)::integer <> -1)
       or (position between 9 and 10 and (value::text)::integer not between 0 and 9)
  ) then
    raise exception 'invalid exact10 card values';
  end if;

  select * into v_existing_event
  from public.shoe_round_card_events
  where source = v_source and table_id = v_table and shoe_no = v_shoe and round_no = v_round
  for update;

  if v_existing_event.id is not null and v_existing_event.event_hash is distinct from v_hash then
    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, deck_count, complete_through_round,
      seen_dealt_rank_counts, undealt_after_observed_deals, cards_seen_dealt,
      physical_remaining_exact, burn_observation_status, status, ledger_checksum, revision
    ) values (
      v_source, v_table, v_shoe, 8, 0, '{}'::jsonb, '{}'::jsonb, 0,
      false, 'unavailable', 'conflicted', repeat('0', 64), 0
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'conflicted', updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'conflicted', 'reason', 'conflicting_round_identity');
  end if;

  select * into v_existing_ledger
  from public.shoe_rank_ledgers
  where source = v_source and table_id = v_table and shoe_no = v_shoe
  for update;

  if v_existing_ledger.status in ('conflicted', 'invalid', 'closed') then
    return jsonb_build_object('accepted', false, 'status', v_existing_ledger.status, 'revision', v_existing_ledger.revision);
  end if;

  if v_existing_event.applied is true then
    return jsonb_build_object('accepted', true, 'duplicate', true, 'status', v_existing_ledger.status,
      'complete_through_round', v_existing_ledger.complete_through_round, 'revision', v_existing_ledger.revision);
  end if;

  v_expected := coalesce(v_existing_ledger.complete_through_round, 0) + 1;
  if v_round <> v_expected then
    insert into public.shoe_round_card_events (
      source, table_id, shoe_no, round_no, raw_result_exact10, dealt_rank_delta, source_action, event_hash, applied
    ) values (
      v_source, v_table, v_shoe, v_round, p_event->'raw_result_exact10', p_event->'dealt_rank_delta', v_action, v_hash, false
    ) on conflict (source, table_id, shoe_no, round_no) do nothing;

    insert into public.shoe_rank_ledgers (
      source, table_id, shoe_no, deck_count, complete_through_round,
      seen_dealt_rank_counts, undealt_after_observed_deals, cards_seen_dealt,
      physical_remaining_exact, burn_observation_status, status, ledger_checksum, revision
    ) values (
      v_source, v_table, v_shoe, 8, 0, '{}'::jsonb, '{}'::jsonb, 0,
      false, 'unavailable', 'gap', repeat('0', 64), 0
    ) on conflict (source, table_id, shoe_no) do update
      set status = 'gap', updated_at = now();
    return jsonb_build_object('accepted', false, 'status', 'gap', 'expected_round', v_expected);
  end if;

  if p_ledger->>'source' is distinct from v_source
     or p_ledger->>'table_id' is distinct from v_table
     or p_ledger->>'shoe_no' is distinct from v_shoe
     or (p_ledger->>'deck_count')::integer is distinct from 8
     or (p_ledger->>'complete_through_round')::integer is distinct from v_round
     or p_ledger->>'status' is distinct from 'contiguous'
     or coalesce((p_ledger->>'physical_remaining_exact')::boolean, true) is not false
     or p_ledger->>'burn_observation_status' is distinct from 'unavailable'
     or jsonb_typeof(p_ledger->'seen_dealt_rank_counts') <> 'object'
     or jsonb_typeof(p_ledger->'undealt_after_observed_deals') <> 'object'
     or coalesce(p_ledger->>'ledger_checksum', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'next ledger snapshot identity or semantics mismatch';
  end if;

  v_cards_seen := (p_ledger->>'cards_seen_dealt')::integer;
  select exists (
    select 1 from jsonb_each_text(p_ledger->'seen_dealt_rank_counts') where value::integer not between 0 and 32
  ) or exists (
    select 1 from jsonb_each_text(p_ledger->'undealt_after_observed_deals') where value::integer not between 0 and 32
  ) into v_bad_count;
  if v_cards_seen not between 0 and 416 or v_bad_count
     or (select count(*) from jsonb_object_keys(p_ledger->'seen_dealt_rank_counts')) <> 13
     or (select count(*) from jsonb_object_keys(p_ledger->'undealt_after_observed_deals')) <> 13
     or exists (select 1 from jsonb_object_keys(p_ledger->'seen_dealt_rank_counts') as k where k not in ('A','2','3','4','5','6','7','8','9','10','J','Q','K'))
     or exists (select 1 from jsonb_object_keys(p_ledger->'undealt_after_observed_deals') as k where k not in ('A','2','3','4','5','6','7','8','9','10','J','Q','K'))
     or (select coalesce(sum(value::integer), 0) from jsonb_each_text(p_ledger->'seen_dealt_rank_counts')) <> v_cards_seen
     or exists (
       select 1
       from jsonb_each_text(p_ledger->'seen_dealt_rank_counts') seen
       where seen.value::integer + (p_ledger->'undealt_after_observed_deals'->>seen.key)::integer <> 32
     ) then
    raise exception 'next ledger card counts invalid';
  end if;

  if exists (
    with all_codes as (
      select (card.value::text)::integer as code
      from public.shoe_round_card_events e
      cross join lateral jsonb_array_elements(e.raw_result_exact10) with ordinality card(value, position)
      where e.source = v_source and e.table_id = v_table and e.shoe_no = v_shoe
        and e.applied is true and card.position between 1 and 6 and (card.value::text)::integer between 1 and 52
      union all
      select (card.value::text)::integer
      from jsonb_array_elements(p_event->'raw_result_exact10') with ordinality card(value, position)
      where card.position between 1 and 6 and (card.value::text)::integer between 1 and 52
    )
    select 1 from all_codes group by code having count(*) > 8
  ) then
    raise exception 'concrete card code exceeds eight-deck limit';
  end if;

  insert into public.shoe_round_card_events (
    source, table_id, shoe_no, round_no, raw_result_exact10, dealt_rank_delta, source_action, event_hash, applied
  ) values (
    v_source, v_table, v_shoe, v_round, p_event->'raw_result_exact10', p_event->'dealt_rank_delta', v_action, v_hash, true
  ) on conflict (source, table_id, shoe_no, round_no) do update
    set applied = true
    where shoe_round_card_events.event_hash = excluded.event_hash
      and shoe_round_card_events.applied = false;

  insert into public.shoe_rank_ledgers (
    source, table_id, shoe_no, deck_count, complete_through_round,
    seen_dealt_rank_counts, undealt_after_observed_deals, cards_seen_dealt,
    burn_count, burn_rank_counts, physical_remaining_exact, burn_observation_status,
    status, ledger_checksum, revision
  ) values (
    v_source, v_table, v_shoe, 8, v_round,
    p_ledger->'seen_dealt_rank_counts', p_ledger->'undealt_after_observed_deals', v_cards_seen,
    null, null, false, 'unavailable', 'contiguous', p_ledger->>'ledger_checksum', 1
  ) on conflict (source, table_id, shoe_no) do update set
    complete_through_round = excluded.complete_through_round,
    seen_dealt_rank_counts = excluded.seen_dealt_rank_counts,
    undealt_after_observed_deals = excluded.undealt_after_observed_deals,
    cards_seen_dealt = excluded.cards_seen_dealt,
    status = 'contiguous',
    ledger_checksum = excluded.ledger_checksum,
    revision = shoe_rank_ledgers.revision + 1,
    updated_at = now();

  return jsonb_build_object('accepted', true, 'duplicate', false, 'status', 'contiguous',
    'complete_through_round', v_round,
    'revision', coalesce(v_existing_ledger.revision, 0) + 1);
end;
$$;

revoke all on function public.apply_v100_rank_ledger_event(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_v100_rank_ledger_event(jsonb, jsonb) to service_role;
