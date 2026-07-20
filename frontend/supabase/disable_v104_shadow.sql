-- Non-destructive v104 shadow disable. All issuance and settlement evidence is retained.
begin;

update public.v104_shadow_runtime_settings
set enabled = false, status = 'shadow_disabled', updated_at = now()
where release_candidate = 'v104.0.0-shadow.1';

revoke execute on function public.issue_v104_shadow_prediction(jsonb) from service_role;
revoke execute on function public.settle_v104_shadow_prediction(jsonb) from service_role;

do $$
begin
  if not exists (
    select 1 from public.v104_shadow_runtime_settings
    where release_candidate = 'v104.0.0-shadow.1' and enabled = false and status = 'shadow_disabled'
  ) then raise exception 'v104 shadow disable evidence is missing'; end if;
end;
$$;

commit;
