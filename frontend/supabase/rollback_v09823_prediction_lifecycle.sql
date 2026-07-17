-- v098.23 non-destructive application-first rollback.
-- 1. Roll the application back first and verify no instance calls reconcile_v09823_prediction_lifecycle.
-- 2. Then disable only the v098.23 entry points. Evidence columns, backup, rows, and v098.21 RPCs remain.
revoke execute on function public.get_v09823_prediction_lifecycle_stats() from service_role;
revoke execute on function public.reconcile_v09823_prediction_lifecycle(text, text, text, integer) from service_role;