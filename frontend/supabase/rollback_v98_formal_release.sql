-- Application-first rollback for the additive v98 formal strategy release.
begin;

update public.ai_strategy_versions
set status = 'archived'
where version = 'v98';

update public.ai_strategy_versions strategy
set status = 'active'
where strategy.version = (
  select previous.version
  from public.v98_formal_release_previous_active previous
  order by previous.captured_at desc, previous.version
  limit 1
);

do $$
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1 then
    raise exception 'v98 rollback requires exactly one recorded predecessor';
  end if;
end;
$$;

commit;
