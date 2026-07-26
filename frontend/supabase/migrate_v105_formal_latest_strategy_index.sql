create index concurrently if not exists daily_prediction_results_v105_latest_strategy_idx
  on public.daily_prediction_results (table_id, strategy_version, prediction_issued_at desc)
  where prediction_issued_at is not null;
