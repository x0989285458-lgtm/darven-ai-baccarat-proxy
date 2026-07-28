-- V8.3: keep v105 lifecycle reconciliation on the small unsettled working set.
-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction.
create index concurrently if not exists daily_prediction_results_v105_pending_lifecycle_idx
  on public.daily_prediction_results (source, table_id, strategy_version, shoe_no, round_no)
  where prediction_issued_at is not null
    and settlement_final is not true;
