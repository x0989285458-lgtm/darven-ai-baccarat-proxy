-- Cutover admission fence: stop only NEW v105 immutable issuances.
-- The row UPDATE is the fence-side half of the concurrency barrier. It waits for
-- every issue_v105_prediction transaction holding FOR SHARE, then commits false.
-- Existing v105 settlements remain authorized so immutable late Finals can settle.
begin;

update public.ai_strategy_versions
set issuance_enabled = false
where version = 'v105';

DO $$
begin
  if not exists (
    select 1 from public.ai_strategy_versions
    where version = 'v105' and issuance_enabled is false
  ) then
    raise exception 'v105 issuance row fence was not persisted';
  end if;
end;
$$;

revoke execute on function public.issue_v105_prediction(jsonb) from service_role;
commit;
