-- V8.3 rollback: remove only the lifecycle acceleration index; preserve all prediction evidence.
-- DROP INDEX CONCURRENTLY must run outside an explicit transaction.
drop index concurrently if exists public.daily_prediction_results_v105_pending_lifecycle_idx;
