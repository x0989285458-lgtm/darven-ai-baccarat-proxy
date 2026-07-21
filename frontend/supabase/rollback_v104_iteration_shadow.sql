-- Non-destructive rollback: stop all new issuance/settlement, preserve every audit row and read-only view.
begin;
update public.v104_iteration_shadow_runtime_settings
set enabled=false,status='shadow_disabled',updated_at=now()
where release_candidate='v104.1.0-seven-head-shadow.1';
revoke execute on function public.issue_v104_iteration_shadow_prediction(jsonb) from service_role;
revoke execute on function public.settle_v104_iteration_shadow_prediction(jsonb) from service_role;
revoke execute on function public.persist_v104_iteration_shadow_artifacts(jsonb,jsonb) from service_role;
revoke execute on function public.review_v104_iteration_shadow_suggestion(text,text,text) from service_role;
commit;
