-- Cutover admission fence: stop only NEW v105 immutable issuances.
-- Existing v105 settlements remain authorized so the pending set can drain to zero.
begin;
revoke execute on function public.issue_v105_prediction(jsonb) from service_role;
commit;
