begin;

-- v098.10：沿用v097正式權重與副預測設定，只替換主信心校準與Active版本識別。
insert into public.ai_strategy_versions(version, status, sample_count, weights, metrics, notes)
select
  'v098_主信心實際命中校準版',
  'archived',
  sample_count,
  weights,
  coalesce(metrics, '{}'::jsonb) || jsonb_build_object(
    'confidence_calibration', 'settled_hit_rate_with_18_round_reliability',
    'confidence_min', 30,
    'confidence_max', 70,
    'direction_weights_changed', false,
    'side_prediction_changed', false
  ),
  'v098 formal strategy: main confidence is calibrated by settled real-card hit rate; main direction, weights, side ratios and thresholds remain unchanged.'
from public.ai_strategy_versions
where version = 'v097_副預測命中校準與門檻降5版'
on conflict (version) do update set
  status = 'archived',
  sample_count = excluded.sample_count,
  weights = excluded.weights,
  metrics = excluded.metrics,
  notes = excluded.notes;

update public.ai_strategy_versions
set status = 'archived'
where status = 'active'
  and version <> 'v098_主信心實際命中校準版';

update public.ai_strategy_versions
set status = 'active'
where version = 'v098_主信心實際命中校準版';

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (
       select 1 from public.ai_strategy_versions
       where status = 'active' and version = 'v098_主信心實際命中校準版'
     ) then
    raise exception 'v098 active strategy migration failed';
  end if;
end;
$$;

create unique index if not exists uq_ai_strategy_versions_one_active
  on public.ai_strategy_versions(status)
  where (status = 'active');

commit;
