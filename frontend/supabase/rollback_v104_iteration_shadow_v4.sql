-- Non-destructive rollback after an explicit v4 drain: preserve v4 evidence and restore the prior v3 runtime.
begin;

do $$
declare pending_count bigint; current_status text;
begin
  select status into current_status
  from public.v104_iteration_shadow_v4_runtime_settings
  where release_candidate='v104.4.0-seven-head-shadow.4'
  for update;
  select count(*) into pending_count
  from public.v104_iteration_shadow_v4_issuances i
  left join public.v104_iteration_shadow_v4_settlements s on s.prediction_id=i.id
  where s.id is null;
  if current_status is distinct from 'shadow_disabled' or pending_count <> 0 then
    raise exception 'v104 iteration shadow v4 must be fully drained before rollback';
  end if;
end;
$$;

update public.v104_iteration_shadow_v4_runtime_settings
set enabled=false,status='shadow_disabled',updated_at=now()
where release_candidate='v104.4.0-seven-head-shadow.4';

do $$
declare restored_enabled boolean; restored_status text;
begin
  update public.v104_iteration_shadow_v3_runtime_settings
  set enabled=true,status='shadow',updated_at=now()
  where release_candidate='v104.3.0-seven-head-shadow.3';
  if not found then
    raise exception 'v3 runtime restore failed';
  end if;
  select enabled,status into restored_enabled,restored_status
  from public.v104_iteration_shadow_v3_runtime_settings
  where release_candidate='v104.3.0-seven-head-shadow.3'
  for share;
  if restored_enabled is distinct from true or restored_status is distinct from 'shadow' then
    raise exception 'v3 runtime restore failed';
  end if;
end;
$$;

grant execute on function public.issue_v104_iteration_shadow_v3_prediction(jsonb) to service_role;
grant execute on function public.settle_v104_iteration_shadow_v3_prediction(jsonb) to service_role;
grant execute on function public.persist_v104_iteration_shadow_v3_artifacts(jsonb,jsonb) to service_role;
grant execute on function public.review_v104_iteration_shadow_v3_suggestion(text,text,text) to service_role;

revoke execute on function public.issue_v104_iteration_shadow_v4_prediction(jsonb) from service_role;
revoke execute on function public.settle_v104_iteration_shadow_v4_prediction(jsonb) from service_role;
revoke execute on function public.persist_v104_iteration_shadow_v4_artifacts(jsonb,jsonb) from service_role;
revoke execute on function public.review_v104_iteration_shadow_v4_suggestion(text,text,text) from service_role;
revoke execute on function public.begin_v104_iteration_shadow_v4_drain() from service_role;
revoke execute on function public.finish_v104_iteration_shadow_v4_drain() from service_role;
commit;
