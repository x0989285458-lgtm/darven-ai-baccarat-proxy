-- v98 formal release: additive strategy activation only. Worker protocol remains 098.
begin;

create table if not exists public.v98_formal_release_previous_active (
  version text primary key,
  captured_at timestamptz not null default now()
);

delete from public.v98_formal_release_previous_active;

insert into public.v98_formal_release_previous_active(version)
select version
from public.ai_strategy_versions
where status = 'active' and version <> 'v98'
on conflict (version) do nothing;

insert into public.ai_strategy_versions(version, status, sample_count, weights, metrics, notes, activated_at)
values (
  'v98',
  'archived',
  0,
  '{"ask_road_signals":0.25,"roadmap_trend_signals":0.45,"recent_practical_calibration":0.20,"shoe_banker_player_bias":0.10}'::jsonb,
  '{"mode":"formal_live_prediction","release":"v98","auto_adjust":false,"main_weights":{"ask_road_signals":0.25,"roadmap_trend_signals":0.45,"recent_practical_calibration":0.20,"shoe_banker_player_bias":0.10},"side_thresholds":{"tie":25,"superSix":45,"bankerPair":43,"playerPair":43,"bankerDragon":30,"playerDragon":30},"side_weights_changed":false,"direction_gates_changed":false}'::jsonb,
  'Formal v98 strategy. Previous active strategy is archived with rollback provenance preserved.',
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
set status = 'active', activated_at = coalesce(activated_at, now())
where version = 'v98';

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v98') then
    raise exception 'v98 formal strategy activation failed';
  end if;
end;
$$;

create unique index if not exists uq_ai_strategy_versions_one_active
  on public.ai_strategy_versions(status)
  where (status = 'active');

commit;
