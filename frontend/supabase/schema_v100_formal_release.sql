-- v100 formal release: activate the unified v100 product strategy without deleting history.
begin;

create table if not exists public.v100_formal_release_previous_active (
  version text primary key,
  captured_at timestamptz not null default now()
);

alter table public.v100_formal_release_previous_active enable row level security;
revoke all on table public.v100_formal_release_previous_active from public, anon, authenticated, service_role;

insert into public.v100_formal_release_previous_active(version)
select version
from public.ai_strategy_versions
where status = 'active'
  and version <> 'v100'
  and not exists (select 1 from public.v100_formal_release_previous_active)
on conflict (version) do nothing;

do $$
begin
  if to_regclass('public.shoe_round_card_events') is null
     or to_regclass('public.shoe_rank_ledgers') is null
     or to_regprocedure('public.apply_v100_rank_ledger_event(jsonb,jsonb)') is null then
    raise exception 'v100 rank-ledger prerequisites are not installed';
  end if;
  if (select count(*) from public.v100_formal_release_previous_active) <> 1 then
    raise exception 'v100 formal release requires exactly one preserved predecessor';
  end if;
end;
$$;

insert into public.ai_strategy_versions(version, status, sample_count, weights, metrics, notes, activated_at)
values (
  'v100',
  'archived',
  0,
  '{"ask_road_signals":0.25,"roadmap_trend_signals":0.45,"recent_practical_calibration":0.20,"shoe_banker_player_bias":0.10}'::jsonb,
  '{"mode":"formal_live_prediction","release":"v100","auto_adjust":false,"main_strategy":"v99_主預測靴內偏移去重版","side_strategy":"v100_主副訊號去重與8副牌階完整性版","main_weights":{"ask_road_signals":0.25,"roadmap_trend_signals":0.45,"recent_practical_calibration":0.20,"shoe_banker_player_bias":0.10},"side_thresholds":{"tie":25,"superSix":45,"bankerPair":43,"playerPair":43,"bankerDragon":30,"playerDragon":30},"rank_ledger":"durable_eight_deck_exact_rank_ledger","direction_gates_changed":false}'::jsonb,
  'Formal v100 unified package. v98 is retained as read-only history and rollback predecessor.',
  now()
)
on conflict (version) do update set
  status = 'archived',
  weights = excluded.weights,
  metrics = excluded.metrics,
  notes = excluded.notes;

update public.ai_strategy_versions
set status = 'archived'
where status = 'active';

update public.ai_strategy_versions
set status = 'active', activated_at = now()
where version = 'v100';

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v100') then
    raise exception 'v100 formal strategy activation failed';
  end if;
end;
$$;

create unique index if not exists uq_ai_strategy_versions_one_active
  on public.ai_strategy_versions(status)
  where (status = 'active');

commit;
