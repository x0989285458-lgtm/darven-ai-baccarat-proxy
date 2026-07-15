-- v098.19 Final Settlement Gate
-- Keep PostgREST final-only history queries selective before ORDER/LIMIT.

create index concurrently if not exists idx_daily_prediction_results_final_created_at
  on public.daily_prediction_results (created_at desc)
  where (prediction_features ->> 'settlement_final') = 'true';
