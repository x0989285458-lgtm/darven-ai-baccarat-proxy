-- Application-first rollback for the additive v100 formal release.
-- Rank evidence and ledger tables are intentionally retained for audit and later reactivation.
begin;

update public.ai_strategy_versions
set status = 'archived'
where version = 'v100';

update public.ai_strategy_versions strategy
set status = 'active'
where strategy.version = (
  select previous.version
  from public.v100_formal_release_previous_active previous
  order by previous.captured_at desc, previous.version
  limit 1
);

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1 then
    raise exception 'v100 rollback requires exactly one recorded predecessor';
  end if;
end;
$$;

commit;
