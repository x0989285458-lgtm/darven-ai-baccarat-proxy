begin;

update public.v105_shadow_v6_runtime_settings set enabled = false;
update public.v105_shadow_v7_runtime_settings set enabled = false;
update public.v105_shadow_v8_runtime_settings set enabled = false;

do $retire_v105_shadow_v6_v8_functions$
declare
  target record;
begin
  for target in
    select
      n.nspname as schema_name,
      p.proname as function_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any (array[
        'issue_v105_shadow_v6_prediction',
        'settle_v105_shadow_v6_prediction',
        'get_v105_shadow_v6_compact_history',
        'issue_v105_shadow_v7_prediction',
        'settle_v105_shadow_v7_prediction',
        'get_v105_shadow_v7_compact_history',
        'issue_v105_shadow_v8_prediction',
        'settle_v105_shadow_v8_prediction',
        'get_v105_shadow_v8_compact_history'
      ]::pg_catalog.name[])
    order by p.proname, p.oid
  loop
    execute pg_catalog.format(
      'drop function %I.%I(%s)',
      target.schema_name,
      target.function_name,
      target.identity_arguments
    );
  end loop;
end
$retire_v105_shadow_v6_v8_functions$;

drop view if exists public.v105_shadow_v6_history;
drop view if exists public.v105_shadow_v7_history;
drop view if exists public.v105_shadow_v8_history;

drop table if exists public.v105_shadow_v6_settlements;
drop table if exists public.v105_shadow_v7_settlements;
drop table if exists public.v105_shadow_v8_settlements;

drop table if exists public.v105_shadow_v6_issuances;
drop table if exists public.v105_shadow_v7_issuances;
drop table if exists public.v105_shadow_v8_issuances;

drop table if exists public.v105_shadow_v6_sequence_counters;
drop table if exists public.v105_shadow_v7_sequence_counters;
drop table if exists public.v105_shadow_v8_sequence_counters;

drop table if exists public.v105_shadow_v6_runtime_settings;
drop table if exists public.v105_shadow_v7_runtime_settings;
drop table if exists public.v105_shadow_v8_runtime_settings;

do $verify_v105_shadow_v6_v8_absent$
begin
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'issue_v105_shadow_v6_prediction',
        'settle_v105_shadow_v6_prediction',
        'get_v105_shadow_v6_compact_history',
        'issue_v105_shadow_v7_prediction',
        'settle_v105_shadow_v7_prediction',
        'get_v105_shadow_v7_compact_history',
        'issue_v105_shadow_v8_prediction',
        'settle_v105_shadow_v8_prediction',
        'get_v105_shadow_v8_compact_history'
      ]::pg_catalog.name[])
  ) or exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (array[
        'v105_shadow_v6_history',
        'v105_shadow_v6_settlements',
        'v105_shadow_v6_issuances',
        'v105_shadow_v6_sequence_counters',
        'v105_shadow_v6_runtime_settings',
        'v105_shadow_v7_history',
        'v105_shadow_v7_settlements',
        'v105_shadow_v7_issuances',
        'v105_shadow_v7_sequence_counters',
        'v105_shadow_v7_runtime_settings',
        'v105_shadow_v8_history',
        'v105_shadow_v8_settlements',
        'v105_shadow_v8_issuances',
        'v105_shadow_v8_sequence_counters',
        'v105_shadow_v8_runtime_settings'
      ]::pg_catalog.name[])
  ) then
    raise exception 'V6-V8 teardown left database objects behind';
  end if;
end
$verify_v105_shadow_v6_v8_absent$;

commit;
