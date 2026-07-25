create index concurrently if not exists daily_prediction_results_v105_hydration_idx
  on public.daily_prediction_results (table_id, prediction_issued_at desc)
  where prediction_issued_at is not null;
