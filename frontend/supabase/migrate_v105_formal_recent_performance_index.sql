create index concurrently if not exists daily_prediction_results_v105_recent_table_idx
  on public.daily_prediction_results (strategy_version, table_id, created_at desc)
  where settlement_final is true
    and prediction_issued_at is not null;
