begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table
  public.ai_strategy_versions,
  public.v105_shadow_v9_runtime_settings,
  public.v105_shadow_v10_runtime_settings,
  public.v105_shadow_v10_big_road_runtime_settings,
  public.v105_shadow_v10_rank_sync_runtime_settings
in share row exclusive mode;

do $$
declare
  active_count integer;
  active_version text;
begin
  select count(*), min(version)
    into active_count, active_version
  from public.ai_strategy_versions
  where status = 'active';

  if active_count <> 1 or active_version <> 'v105' then
    raise exception 'Main33 disable blocked: expected exactly one active v105 strategy, got count=% version=%',
      active_count, active_version;
  end if;
end
$$;

update public.v105_shadow_v9_runtime_settings
set enabled = false,
    status = 'shadow_disabled',
    updated_at = pg_catalog.now()
where enabled is distinct from false
   or status is distinct from 'shadow_disabled';

update public.v105_shadow_v10_runtime_settings
set enabled = false,
    status = 'shadow_disabled',
    updated_at = pg_catalog.now()
where enabled is distinct from false
   or status is distinct from 'shadow_disabled';

update public.v105_shadow_v10_big_road_runtime_settings
set enabled = false,
    status = 'shadow_disabled',
    updated_at = pg_catalog.now()
where enabled is distinct from false
   or status is distinct from 'shadow_disabled';

update public.v105_shadow_v10_rank_sync_runtime_settings
set enabled = false,
    status = 'shadow_disabled',
    updated_at = pg_catalog.now()
where enabled is distinct from false
   or status is distinct from 'shadow_disabled';

do $$
declare
  enabled_count integer;
  non_disabled_count integer;
begin
  select
    (select count(*) from public.v105_shadow_v9_runtime_settings where enabled is true)
    + (select count(*) from public.v105_shadow_v10_runtime_settings where enabled is true)
    + (select count(*) from public.v105_shadow_v10_big_road_runtime_settings where enabled is true)
    + (select count(*) from public.v105_shadow_v10_rank_sync_runtime_settings where enabled is true),
    (select count(*) from public.v105_shadow_v9_runtime_settings where status is distinct from 'shadow_disabled')
    + (select count(*) from public.v105_shadow_v10_runtime_settings where status is distinct from 'shadow_disabled')
    + (select count(*) from public.v105_shadow_v10_big_road_runtime_settings where status is distinct from 'shadow_disabled')
    + (select count(*) from public.v105_shadow_v10_rank_sync_runtime_settings where status is distinct from 'shadow_disabled')
  into enabled_count, non_disabled_count;

  if enabled_count <> 0 or non_disabled_count <> 0 then
    raise exception 'Main33 disable verification failed: enabled=% non_disabled=%',
      enabled_count, non_disabled_count;
  end if;
end
$$;

commit;
