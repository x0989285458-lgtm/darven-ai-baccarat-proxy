-- Draven AI Baccarat v013 短測桌況權重調整
-- 用途：新增短測桌況近期命中率特徵，並 seed v013_short_run_adjusted 策略權重。
-- 安全：請在 Supabase SQL Editor 或後端受控環境執行；不要把 service role key 寫進前端。

begin;

-- daily_prediction_results：保存短測桌況命中率與策略調整原因，供回測/觀望規則檢視。
alter table public.daily_prediction_results
  add column if not exists table_recent_hit_rate numeric(5,4),
  add column if not exists table_recent_prediction_count integer,
  add column if not exists short_run_adjustment jsonb not null default '{}'::jsonb;

create index if not exists daily_prediction_results_table_recent_hit_rate_idx
  on public.daily_prediction_results (table_id, table_recent_hit_rate, resolved_at desc);

-- v013 策略：路單/問路小幅提高，加入近期桌況命中率；任何單一特徵不超過 15%。
insert into public.ai_strategy_versions (
  version,
  status,
  sample_count,
  weights,
  metrics,
  notes,
  activated_at
) values (
  'v013_short_run_adjusted',
  'active',
  0,
  '{
    "bead_road": 0.15,
    "big_road": 0.15,
    "derived_roads": 0.12,
    "ask_road": 0.15,
    "card_points": 0.10,
    "shoe_remaining_points": 0.08,
    "pattern_tags": 0.10,
    "table_recent_hit_rate": 0.15
  }'::jsonb,
  '{
    "mode": "short_run_adjusted",
    "auto_adjust": true,
    "low_performance_threshold": 0.45,
    "high_performance_threshold": 0.65,
    "low_performance_rule": "recent hit rate < 45% => observe or cap confidence at 50",
    "high_performance_rule": "recent hit rate > 65% => boost confidence by 5~10, capped at 100",
    "description": "依最新短測桌況加入近期命中率；低表現桌觀望/降權，高表現桌小幅加權，路單與問路權重小幅提高。"
  }'::jsonb,
  'v013 短測桌況權重調整策略：珠盤路15%、大路15%、三路12%、莊閒問路15%、開牌點數10%、剩餘點數牌數8%、牌路標籤10%、近期桌況命中率15%。',
  now()
)
on conflict (version) do update set
  status = excluded.status,
  weights = excluded.weights,
  metrics = excluded.metrics,
  notes = excluded.notes,
  activated_at = coalesce(public.ai_strategy_versions.activated_at, excluded.activated_at);

insert into public.app_settings (key, value, description)
values (
  'active_strategy_version',
  '"v013_short_run_adjusted"'::jsonb,
  '目前啟用的 AI 判讀策略版本'
)
on conflict (key) do update set
  value = excluded.value,
  description = excluded.description;

commit;
