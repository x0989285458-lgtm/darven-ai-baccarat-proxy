-- 瑞文 AI 百家 v092 穩定性強化
-- 用途：補上 live writer 去重所需唯一索引，搭配後端佇列/重試避免重送重複統計。
-- 安全：請在 Supabase SQL Editor 或後端受控環境執行；不要把 service role key 寫進前端。

begin;

create unique index if not exists daily_roadmap_events_v092_round_unique
  on public.daily_roadmap_events (source, table_id, shoe_no, round_no);

create unique index if not exists daily_prediction_results_v092_round_strategy_unique
  on public.daily_prediction_results (source, table_id, shoe_no, round_no, strategy_version);

create unique index if not exists cloud_table_rounds_v092_round_unique
  on public.cloud_table_rounds (source, table_id, shoe_no, round_no);

comment on index public.daily_roadmap_events_v092_round_unique is
  'v092 防止同 source/table/shoe/round 完成局重送造成 daily_roadmap_events 重複入庫。';

comment on index public.daily_prediction_results_v092_round_strategy_unique is
  'v092 防止同 source/table/shoe/round/strategy 預測結果重送造成重複統計。';

comment on index public.cloud_table_rounds_v092_round_unique is
  'v092 防止 Worker round event 重送造成 cloud_table_rounds 重複入庫。';

commit;
