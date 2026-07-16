-- v098.21 safe app-first rollback. Review before executing; this file is not auto-executed.
-- 1. Deploy the application rollback first and verify that no running instance calls
--    issue_v09821_prediction or settle_v09821_prediction.
-- 2. Only after application rollback is complete, revoke the new RPC entry points.
-- Evidence columns, constraints, indexes, function definitions, and stored rows are
-- intentionally preserved. Re-applying the v098.21 migration re-grants service access.
revoke execute on function public.settle_v09821_prediction(jsonb, jsonb) from service_role;
revoke execute on function public.issue_v09821_prediction(jsonb) from service_role;
