-- v105 formal: remove the legacy JSON-expression settlement index after the
-- old formal history is retired, then keep ANALYZE away from large immutable
-- JSON payloads. Scalar identity/status columns retain normal statistics.

create index if not exists idx_daily_prediction_results_final_created_at_scalar
  on public.daily_prediction_results (created_at desc)
  where settlement_final is true;

drop index if exists public.idx_daily_prediction_results_final_created_at;

alter table public.daily_prediction_results
  alter column prediction_features set statistics 0,
  alter column probabilities set statistics 0,
  alter column feature_weights set statistics 0,
  alter column short_run_adjustment set statistics 0,
  alter column issued_prediction_payload set statistics 0,
  alter column side_actual_results set statistics 0,
  alter column side_hits set statistics 0;
