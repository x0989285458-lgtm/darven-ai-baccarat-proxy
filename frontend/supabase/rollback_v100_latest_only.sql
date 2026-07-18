-- v100 latest-only emergency application-first rollback.
-- Deploy an application maintenance response before executing this file.
-- This intentionally preserves every v100 table, prediction, rank event, ledger, and schema object.
begin;
revoke execute on function public.get_v100_prediction_lifecycle_stats() from service_role;
revoke execute on function public.reconcile_v100_prediction_lifecycle(text, text, text, integer) from service_role;
revoke execute on function public.persist_v100_settled_round(jsonb, jsonb) from service_role;
revoke execute on function public.settle_v100_prediction(jsonb, jsonb) from service_role;
revoke execute on function public.issue_v100_prediction(jsonb) from service_role;
revoke execute on function public.apply_v100_rank_ledger_event(jsonb, jsonb) from service_role;
commit;
