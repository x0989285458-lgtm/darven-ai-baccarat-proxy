-- Non-destructive v103 shadow disable/rollback. Issuance and settlement evidence is retained.
begin;

update public.v103_shadow_runtime_settings
set enabled = false, status = 'shadow_disabled', updated_at = now()
where release_candidate = 'v103.0.0-shadow.1';

revoke execute on function public.issue_v103_shadow_prediction(jsonb) from service_role;
revoke execute on function public.settle_v103_shadow_prediction(jsonb) from service_role;

do $$
begin
  if not exists (
    select 1 from public.v103_shadow_runtime_settings
    where release_candidate = 'v103.0.0-shadow.1' and enabled = false and status = 'shadow_disabled'
  ) then raise exception 'v103 shadow disable evidence is missing'; end if;
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
     or not exists (select 1 from public.ai_strategy_versions where status = 'active' and version = 'v102') then
    raise exception 'v102 must remain the only Active strategy';
  end if;
end;
$$;

commit;
