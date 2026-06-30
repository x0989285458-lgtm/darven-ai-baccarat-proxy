-- Draven AI Baccarat v012 資料庫落地與平均權重
-- 用途：補足每局牌碼/點數、莊閒龍寶、問路/五路特徵、預測機率、初始平均權重。
-- 安全：請在 Supabase SQL Editor 或後端受控環境執行；不要把 service role key 寫進前端。

begin;

create extension if not exists pgcrypto;

-- daily_roadmap_events：補齊每局學習需要的欄位
alter table public.daily_roadmap_events
  add column if not exists player_card_codes jsonb not null default '[]'::jsonb,
  add column if not exists banker_card_codes jsonb not null default '[]'::jsonb,
  add column if not exists player_card_points jsonb not null default '[]'::jsonb,
  add column if not exists banker_card_points jsonb not null default '[]'::jsonb,
  add column if not exists player_drew boolean not null default false,
  add column if not exists banker_drew boolean not null default false,
  add column if not exists player_natural boolean not null default false,
  add column if not exists banker_natural boolean not null default false,
  add column if not exists banker_dragon boolean not null default false,
  add column if not exists player_dragon boolean not null default false,
  add column if not exists road_features jsonb not null default '{}'::jsonb,
  add column if not exists remaining_point_counts jsonb not null default '{}'::jsonb;

create index if not exists daily_roadmap_events_dragon_idx
  on public.daily_roadmap_events (banker_dragon, player_dragon, opened_at desc);

create index if not exists daily_roadmap_events_cards_gin_idx
  on public.daily_roadmap_events using gin (player_card_points, banker_card_points);

-- daily_prediction_results：記錄當下機率與權重，供回測與自動調權重
alter table public.daily_prediction_results
  add column if not exists probabilities jsonb not null default '{}'::jsonb,
  add column if not exists feature_weights jsonb not null default '{}'::jsonb,
  add column if not exists road_pattern_tags jsonb not null default '[]'::jsonb,
  add column if not exists ask_road_features jsonb not null default '{}'::jsonb;

create index if not exists daily_prediction_results_probabilities_gin_idx
  on public.daily_prediction_results using gin (probabilities);

-- 初始策略：全部特徵群平均權重，後續由資料庫學習/回測成果自動調整
insert into public.ai_strategy_versions (
  version,
  status,
  sample_count,
  weights,
  metrics,
  notes,
  activated_at
) values (
  'v012_equal_weight_seed',
  'active',
  0,
  '{
    "bead_road": 0.125,
    "big_road": 0.125,
    "derived_roads": 0.125,
    "ask_road": 0.125,
    "card_points": 0.125,
    "shoe_remaining_points": 0.125,
    "pattern_tags": 0.125,
    "historical_backtest": 0.125
  }'::jsonb,
  '{
    "mode": "equal_weight_seed",
    "auto_adjust": true,
    "description": "初始平均權重；後續依 daily_roadmap_events 與 daily_prediction_results 回測結果自動調整。"
  }'::jsonb,
  'v012 初始平均權重策略，作為後續資料庫學習調權重的起點。',
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
  '"v012_equal_weight_seed"'::jsonb,
  '目前啟用的 AI 判讀策略版本'
)
on conflict (key) do update set
  value = excluded.value,
  description = excluded.description;

commit;
